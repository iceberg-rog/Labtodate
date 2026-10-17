import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { prisma } from '@/lib/db';
import { getSecurityPolicy, type SecurityPolicy } from '@/lib/security/policy';
import { ensureSettingsLoaded, settingRaw } from '@/lib/settings';
import { allowHit, clearBuckets } from '@/lib/security/throttle';
import { recordPermanentFailure, SUPPRESS_ALL_SCOPE } from './index';
import { bareAddress, bypassesGuards, type EmailTrigger } from './rules';
import { parseDsn, type DsnRecipient, type DsnVerdict, type ParsedDsn } from './dsn';

/**
 * Bounce reports in the sending mailbox. TransIP (production's SMTP) accepts
 * every recipient and e-mails a bounce report (DSN) to the sending mailbox
 * later, so sendEmail never sees the rejection. When MAIL_BOUNCE_IMAP_ENABLED
 * is on, the security sweep (every 5 minutes) logs in over IMAP, looks at the
 * new unread e-mails of one folder, parses the bounce reports among them
 * (./dsn.ts) and feeds each permanently undeliverable address to
 * recordPermanentFailure — the same counting and suppression as a
 * synchronous rejection.
 *
 * The mailbox is also a person's inbox, so: other e-mails are never opened
 * in a way that marks them read (BODY.PEEK) or moved; only a report about an
 * e-mail the site sent (its Message-ID is in EmailLog, to the same address)
 * is marked read or moved to MAIL_BOUNCE_IMAP_DONE_FOLDER. A report that
 * quotes another e-mail stays unread — it's about mail someone sent by hand,
 * or a fake meant to stop mail to a customer. Each run starts after the
 * highest UID the previous run of the same mailbox looked at, so nothing is
 * read twice. Every setting is in Settings → Security (group mailguard); the
 * password is the secret setting MAIL_BOUNCE_IMAP_PASS (empty = SMTP_PASS).
 */

export type BounceOutcome = 'suppressed' | 'already-suppressed' | 'counted' | 'ignored' | 'unmatched';

/** One recipient of one report, as stored on the run (BounceScanRun.items) and shown in the admin. */
export type BounceItem = {
  /** When the report arrived in the mailbox (ISO). */
  at: string | null;
  address: string;
  status: string | null;
  verdict: DsnVerdict;
  outcome: BounceOutcome;
  note: string | null;
  diagnostic: string | null;
  reportFrom: string | null;
};

export type BounceScanStatus = 'OK' | 'FAILED' | 'NOT_CONFIGURED' | 'OFF' | 'BUSY';

export type BounceScanResult = {
  status: BounceScanStatus;
  /** One line for the admin / the sweep's JSON. */
  message: string;
  checked: number;
  reports: number;
  permanent: number;
  suppressed: number;
  ignored: number;
  unmatched: number;
  error?: string;
};

const MAX_SOURCE_BYTES = 512 * 1024; // the report and the bounced e-mail's headers come first
const MAX_ITEMS = 100;
const KEEP_RUNS_DAYS = 30;
const LOCK_KEY = 'lock:bounce-scan';
const LOCK_MS = 90_000;

export type ImapSettings = { smtpUser: string; smtpPass: string; imapPass: string };

export function isLocalHost(host: string): boolean {
  return ['localhost', '127.0.0.1', '::1'].includes(host.toLowerCase());
}

/**
 * Connection options from the policy + secrets (pure). Encrypted always:
 * port 993 = TLS, any other port must offer STARTTLS — except a server on
 * this machine (tests, a local relay).
 */
export function imapConnection(
  policy: Pick<SecurityPolicy, 'MAIL_BOUNCE_IMAP_HOST' | 'MAIL_BOUNCE_IMAP_PORT' | 'MAIL_BOUNCE_IMAP_USER' | 'MAIL_BOUNCE_IMAP_FOLDER'>,
  s: ImapSettings,
): { ok: true; options: ImapFlowOptions; mailbox: string } | { ok: false; missing: string[] } {
  const host = policy.MAIL_BOUNCE_IMAP_HOST.trim();
  const user = policy.MAIL_BOUNCE_IMAP_USER.trim() || s.smtpUser.trim();
  const pass = s.imapPass || s.smtpPass;
  const missing = [
    !host && 'the IMAP server (Settings → Security)',
    !user && 'the login (Settings → Security, or the SMTP username)',
    !pass && 'the password (Settings → Email → Bounce mailbox password, or the SMTP password)',
  ].filter((x): x is string => !!x);
  if (missing.length) return { ok: false, missing };
  const port = policy.MAIL_BOUNCE_IMAP_PORT;
  const secure = port === 993;
  return {
    ok: true,
    mailbox: `${user}@${host}:${port}/${policy.MAIL_BOUNCE_IMAP_FOLDER}`,
    options: {
      host,
      port,
      secure,
      doSTARTTLS: secure || isLocalHost(host) ? undefined : true,
      auth: { user, pass },
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
      clientInfo: { name: 'lab2date bounce reader' },
    },
  };
}

type Structure = { type?: string; parameters?: Record<string, string>; childNodes?: Structure[] };

/** Is this IMAP BODYSTRUCTURE a delivery status report (or a multipart holding one)? Pure. */
export function looksLikeReport(s: Structure | undefined): boolean {
  if (!s) return false;
  const type = (s.type ?? '').toLowerCase();
  if (type === 'multipart/report') return /delivery-status/i.test(s.parameters?.['report-type'] ?? '');
  if (type === 'message/delivery-status' || type === 'message/global-delivery-status') return true;
  return type.startsWith('multipart/') && (s.childNodes ?? []).some(looksLikeReport);
}

/**
 * The address to act on for one report recipient, given where the bounced
 * e-mail went according to EmailLog (`sentTo`, null when the report quotes no
 * e-mail of ours). With `matchRequired` only an address the site mailed. Pure.
 */
export function addressToAct(r: Pick<DsnRecipient, 'finalRecipient' | 'originalRecipient'>, sentTo: string[] | null, matchRequired: boolean): string | null {
  const candidates = [r.originalRecipient, r.finalRecipient].filter((a): a is string => !!a);
  const hit = sentTo?.length ? candidates.find((a) => sentTo.includes(a)) : undefined;
  if (hit) return hit;
  return matchRequired ? null : candidates[0] ?? null;
}

/** Where the e-mail with this Message-ID went, and why it was sent (null: not in the e-mail log). */
async function sentByUs(messageId: string): Promise<{ to: string[]; staffOnly: boolean } | null> {
  const rows = await prisma.emailLog.findMany({
    where: { messageId: { in: [messageId, `<${messageId}>`] } },
    select: { toAddr: true, trigger: true },
    take: 20,
  });
  if (!rows.length) return null;
  return {
    to: rows.flatMap((r) => r.toAddr.split(',').map((a) => bareAddress(a))).filter(Boolean),
    staffOnly: rows.every((r) => !!r.trigger && bypassesGuards(r.trigger as EmailTrigger)),
  };
}

async function suppressedAlready(address: string): Promise<boolean> {
  const row = await prisma.emailSuppression.findUnique({ where: { email_scope: { email: address, scope: SUPPRESS_ALL_SCOPE } }, select: { email: true } });
  return !!row;
}

/** A readable reason for a failed connection / command (never the password). */
export function describeImapError(e: unknown, host: string, port: number): string {
  const err = (e ?? {}) as { message?: string; code?: string; authenticationFailed?: boolean; responseText?: string; serverResponseCode?: string };
  const text = `${err.responseText ?? ''} ${err.message ?? ''}`.trim();
  if (err.authenticationFailed || /AUTHENTICATIONFAILED|authentication failed|invalid credentials|LOGIN failed/i.test(text)) {
    return 'The mail server refused the login — check the bounce mailbox login and password.';
  }
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return `The server name ${host} was not found.`;
  if (err.code === 'ECONNREFUSED') return `Nothing answered on ${host}:${port}.`;
  if (err.code === 'ETIMEDOUT' || err.code === 'CONNECT_TIMEOUT' || err.code === 'GREETING_TIMEOUT' || /timed? ?out/i.test(text)) {
    return `No answer from ${host}:${port} in time.`;
  }
  if (/STARTTLS/i.test(text)) return `${host}:${port} offers no encryption (STARTTLS); use port 993.`;
  if (err.serverResponseCode === 'NONEXISTENT' || /doesn.?t exist|does not exist|no such mailbox|unknown mailbox/i.test(text)) {
    return `The folder does not exist in the mailbox (${text.slice(0, 200)}).`;
  }
  return (text || String(e)).slice(0, 300);
}

function emptyCounts() {
  return { checked: 0, reports: 0, permanent: 0, suppressed: 0, ignored: 0, unmatched: 0 };
}

function summary(status: BounceScanStatus, c: ReturnType<typeof emptyCounts>, error?: string): string {
  if (status === 'OFF') return 'Reading bounce reports is switched off.';
  if (status === 'BUSY') return 'The bounce mailbox is being read right now — try again in a minute.';
  if (status !== 'OK') return error ?? 'The bounce mailbox could not be read.';
  if (!c.checked) return 'No new e-mails in the bounce mailbox.';
  return `${c.checked} new e-mail${c.checked === 1 ? '' : 's'}, ${c.reports} bounce report${c.reports === 1 ? '' : 's'}: ${c.permanent} address${c.permanent === 1 ? '' : 'es'} undeliverable (${c.suppressed} newly suppressed), ${c.ignored} not counted, ${c.unmatched} not about the site’s e-mail.`;
}

/**
 * Read new bounce reports from the sending mailbox and act on them. Writes a
 * BounceScanRun row (except when switched off or another run holds the lock).
 * Never throws.
 */
export async function scanBounceMailbox(opts: { trigger: 'sweep' | 'admin'; policy?: SecurityPolicy }): Promise<BounceScanResult> {
  const counts = emptyCounts();
  const policy = opts.policy ?? (await getSecurityPolicy());
  if (!policy.MAIL_BOUNCE_IMAP_ENABLED) return { status: 'OFF', message: summary('OFF', counts), ...counts };

  await ensureSettingsLoaded();
  const conn = imapConnection(policy, {
    smtpUser: settingRaw('SMTP_USER'),
    smtpPass: settingRaw('SMTP_PASS'),
    imapPass: settingRaw('MAIL_BOUNCE_IMAP_PASS'),
  });
  const startedAt = new Date();
  if (!conn.ok) {
    const error = `Reading bounce reports is switched on, but ${conn.missing.join(' and ')} ${conn.missing.length === 1 ? 'is' : 'are'} missing.`;
    await prisma.bounceScanRun
      .create({ data: { startedAt, finishedAt: new Date(), status: 'NOT_CONFIGURED', trigger: opts.trigger, error } })
      .catch(() => {});
    return { status: 'NOT_CONFIGURED', message: error, error, ...counts };
  }

  const { allowed } = await allowHit(LOCK_KEY, 1, LOCK_MS);
  if (!allowed) return { status: 'BUSY', message: summary('BUSY', counts), ...counts };

  const host = String(conn.options.host);
  const port = Number(conn.options.port);
  const folder = policy.MAIL_BOUNCE_IMAP_FOLDER;
  const doneFolder = policy.MAIL_BOUNCE_IMAP_DONE_FOLDER.trim();
  const items: BounceItem[] = [];
  let uidValidity: bigint | null = null;
  let lastUid: bigint | null = null;
  let error: string | undefined;

  const client = new ImapFlow(conn.options);
  // A dropped connection is reported by the command that was running.
  client.on('error', () => {});
  try {
    const previous = await prisma.bounceScanRun.findFirst({
      where: { mailbox: conn.mailbox, lastUid: { not: null } },
      orderBy: { startedAt: 'desc' },
      select: { uidValidity: true, lastUid: true },
    });
    await client.connect();
    if (doneFolder) {
      const folders = await client.list();
      if (!folders.some((f) => f.path.toLowerCase() === doneFolder.toLowerCase())) await client.mailboxCreate(doneFolder);
    }
    const lock = await client.getMailboxLock(folder);
    try {
      const box = client.mailbox;
      uidValidity = box ? BigInt(box.uidValidity) : null;
      // A new UIDVALIDITY means the folder was recreated: its UIDs start over.
      const after = previous && previous.uidValidity === uidValidity ? (previous.lastUid ?? 0n) : 0n;
      lastUid = after;
      const found = (await client.search({ seen: false, uid: `${after + 1n}:*` }, { uid: true })) || [];
      const uids = found
        .map((u) => BigInt(u))
        .filter((u) => u > after)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, policy.MAIL_BOUNCE_IMAP_MAX_PER_RUN);
      counts.checked = uids.length;

      const candidates: { uid: bigint; at: Date | null }[] = [];
      if (uids.length) {
        for await (const msg of client.fetch(uids.join(','), { uid: true, bodyStructure: true, internalDate: true }, { uid: true })) {
          if (looksLikeReport(msg.bodyStructure as Structure | undefined)) {
            candidates.push({ uid: BigInt(msg.uid), at: msg.internalDate ? new Date(msg.internalDate) : null });
          }
        }
      }
      const candidateAt = new Map(candidates.map((c) => [c.uid, c.at]));

      for (const uid of uids) {
        if (candidateAt.has(uid)) {
          const msg = await client.fetchOne(String(uid), { uid: true, source: { maxLength: MAX_SOURCE_BYTES } }, { uid: true });
          const dsn = msg && msg.source ? await parseDsn(msg.source).catch(() => null) : null;
          if (dsn) {
            counts.reports++;
            const handled = await actOnReport(dsn, candidateAt.get(uid) ?? null, policy, counts, items);
            if (handled) {
              await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
              if (doneFolder) await client.messageMove(String(uid), doneFolder, { uid: true });
            }
          }
        }
        lastUid = uid; // fully handled: the next run starts after it
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    error = describeImapError(e, host, port);
  } finally {
    await client.logout().catch(() => client.close());
    // The lock only guards a running read (it expires by itself if this process dies).
    await clearBuckets([LOCK_KEY]).catch(() => {});
  }

  const status: BounceScanStatus = error ? 'FAILED' : 'OK';
  await prisma.bounceScanRun
    .create({
      data: {
        startedAt,
        finishedAt: new Date(),
        status,
        trigger: opts.trigger,
        mailbox: conn.mailbox,
        ...counts,
        uidValidity,
        lastUid: uidValidity === null ? null : lastUid,
        error: error ?? null,
        items: items.length ? items.slice(0, MAX_ITEMS) : undefined,
      },
    })
    .catch(() => {});
  await prisma.bounceScanRun.deleteMany({ where: { startedAt: { lt: new Date(Date.now() - KEEP_RUNS_DAYS * 24 * 3600_000) } } }).catch(() => {});
  return { status, message: summary(status, counts, error), error, ...counts };
}

/**
 * Count / suppress the recipients of one report. Returns whether the report
 * was about an e-mail of ours (then it is marked read or moved).
 */
async function actOnReport(
  dsn: ParsedDsn,
  at: Date | null,
  policy: SecurityPolicy,
  counts: ReturnType<typeof emptyCounts>,
  items: BounceItem[],
): Promise<boolean> {
  const sent = dsn.originalMessageId ? await sentByUs(dsn.originalMessageId) : null;
  const base = { at: at?.toISOString() ?? null, reportFrom: dsn.reportFrom };
  if (!dsn.recipients.length) {
    counts.unmatched++;
    items.push({ ...base, address: '(none)', status: null, verdict: 'other', outcome: 'unmatched', note: 'the report names no recipient', diagnostic: null });
    return false;
  }
  let handled = false;
  for (const r of dsn.recipients) {
    const item = { ...base, status: r.status, verdict: r.verdict, diagnostic: r.diagnostic };
    const address = addressToAct(r, sent?.to ?? null, policy.MAIL_BOUNCE_IMAP_MATCH_REQUIRED);
    if (!address) {
      counts.unmatched++;
      items.push({
        ...item,
        address: r.originalRecipient ?? r.finalRecipient,
        outcome: 'unmatched',
        note: !dsn.originalMessageId
          ? 'the report quotes no Message-ID — left unread'
          : sent
            ? 'the site’s e-mail with that Message-ID went to another address — left unread'
            : 'not about an e-mail the site sent — left unread',
      });
      continue;
    }
    handled = true;
    if (r.verdict !== 'permanent') {
      counts.ignored++;
      const why = { temporary: 'temporary — the server keeps trying', policy: 'refused by a policy / spam filter (5.7.x) — says nothing about the address', other: 'not about the address (full mailbox, size, content …)', delivered: 'a delivery confirmation' } as const;
      items.push({ ...item, address, outcome: 'ignored', note: why[r.verdict] });
      continue;
    }
    if (sent?.staffOnly) {
      counts.ignored++;
      items.push({ ...item, address, outcome: 'ignored', note: 'staff copy or admin e-mail — never suppressed' });
      continue;
    }
    counts.permanent++;
    if (policy.MAIL_BOUNCE_SUPPRESS_AFTER <= 0) {
      items.push({ ...item, address, outcome: 'ignored', note: 'bounce suppression is off (Settings → Security)' });
      continue;
    }
    if (await suppressedAlready(address).catch(() => false)) {
      items.push({ ...item, address, outcome: 'already-suppressed', note: null });
      continue;
    }
    const detail = `bounce report ${r.status ?? ''} from ${dsn.reportingMta ?? dsn.reportFrom ?? 'the mail server'}: ${r.diagnostic ?? r.action ?? 'failed'}`.replace(/\s+/g, ' ');
    const now = await recordPermanentFailure(address, detail, policy);
    if (now) counts.suppressed++;
    items.push({ ...item, address, outcome: now ? 'suppressed' : 'counted', note: now ? null : `counted (suppressed after ${policy.MAIL_BOUNCE_SUPPRESS_AFTER})` });
  }
  return handled;
}

/** Latest runs for the admin page (newest first). */
export async function recentBounceScans(take = 20) {
  return prisma.bounceScanRun.findMany({ orderBy: { startedAt: 'desc' }, take });
}
