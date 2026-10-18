import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { settingDef, validateSettingValue, normaliseInput } from '@/lib/settings/defs';
import { SUPPORT_SETTING_DEFS } from './settings-defs';
import {
  computeTicketDueAt,
  highKeywords,
  magicLinkExpiry,
  matchTopic,
  reopenDays,
  supportReplyPromise,
  supportTopics,
  ticketRateLimit,
  ticketSlaHours,
  urgentKeywords,
  vipLifetimeCents,
} from './policy';
import { staffReplyMail, ticketReceivedMail, ticketStatusMail } from './mail';

const KEYS = [...SUPPORT_SETTING_DEFS.map((d) => d.key), 'BUSINESS_TIMEZONE', 'SITE_NAME'];
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
});

const v = (key: string, raw: string) => {
  const d = settingDef(key)!;
  return validateSettingValue(d, normaliseInput(d, raw));
};

test('every Support setting is registered in the Support group with a valid default', () => {
  assert.ok(SUPPORT_SETTING_DEFS.length >= 10);
  for (const s of SUPPORT_SETTING_DEFS) {
    const d = settingDef(s.key);
    assert.ok(d, `${s.key} missing from the registry`);
    assert.equal(d.group, 'Support', s.key);
    if (d.default !== undefined) assert.equal(validateSettingValue(d, d.default), null, `default of ${s.key}`);
  }
  for (const k of ['SUPPORT_TOPICS', 'TICKET_SLA_HOURS', 'SUPPORT_BUSINESS_HOURS', 'SUPPORT_REPLY_PROMISE', 'SUPPORT_VIP_LIFETIME_CENTS',
    'SUPPORT_URGENT_KEYWORDS', 'SUPPORT_HIGH_KEYWORDS', 'SUPPORT_MAGIC_LINK_DAYS', 'TICKET_REOPEN_DAYS', 'TICKET_RATE_LIMIT']) {
    assert.ok(settingDef(k), k);
  }
});

test('Support settings validation', () => {
  assert.match(v('TICKET_SLA_HOURS', 'VIP:2') ?? '', /NORMAL is required/);
  assert.equal(v('TICKET_SLA_HOURS', 'VIP:1,NORMAL:8'), null);
  assert.match(v('SUPPORT_BUSINESS_HOURS', '9 to 5') ?? '', /day or a day range/);
  assert.equal(v('SUPPORT_BUSINESS_HOURS', 'Mon-Fri 09:00-17:00'), null);
  assert.equal(v('SUPPORT_URGENT_KEYWORDS', 'none'), null);
  assert.match(v('SUPPORT_TOPICS', `General,${'x'.repeat(61)}`) ?? '', /at most 60/);
  assert.match(v('TICKET_REOPEN_DAYS', '0') ?? '', /at least 1/);
  assert.equal(normaliseInput(settingDef('SUPPORT_VIP_LIFETIME_CENTS')!, '25000'), '2500000');
});

test('policy getters follow the settings (defaults when unset)', () => {
  assert.deepEqual(supportTopics(), ['General', 'Order / delivery', 'Quote / pricing', 'Selling', 'Technical', 'Billing']);
  assert.equal(matchTopic('billing'), 'Billing');
  assert.equal(matchTopic('Anything'), null);
  assert.equal(supportReplyPromise(), '1 business day');
  assert.equal(vipLifetimeCents(), 50_000_00);
  assert.equal(ticketSlaHours('HIGH'), 8);
  assert.equal(reopenDays(), 14);
  assert.deepEqual(ticketRateLimit(), { max: 5, windowMs: 600_000 });
  assert.ok(urgentKeywords().includes('chargeback'));

  Object.assign(process.env, {
    SUPPORT_TOPICS: 'Orders, Returns',
    SUPPORT_REPLY_PROMISE: 'none',
    SUPPORT_VIP_LIFETIME_CENTS: '2500000',
    TICKET_SLA_HOURS: 'VIP:1,HIGH:4,NORMAL:8',
    SUPPORT_URGENT_KEYWORDS: 'none',
    SUPPORT_HIGH_KEYWORDS: 'broken, rma',
    SUPPORT_MAGIC_LINK_DAYS: '30',
    TICKET_RATE_LIMIT: '2',
    TICKET_RATE_WINDOW_MINUTES: '60',
  });
  assert.deepEqual(supportTopics(), ['Orders', 'Returns']);
  assert.equal(supportReplyPromise(), '');
  assert.equal(vipLifetimeCents(), 25_000_00);
  assert.equal(ticketSlaHours('LOW'), 8); // unknown tier → NORMAL
  assert.deepEqual(urgentKeywords(), []);
  assert.deepEqual(highKeywords(), ['broken', 'rma']);
  assert.deepEqual(ticketRateLimit(), { max: 2, windowMs: 3_600_000 });
  const now = new Date('2026-10-20T09:00:00Z');
  assert.equal(magicLinkExpiry(now).toISOString(), '2026-11-19T09:00:00.000Z');
});

test('the reply deadline uses the SLA hours and, when set, the business hours', () => {
  const tue = new Date('2026-10-20T15:00:00Z'); // Tuesday 17:00 Amsterdam
  assert.equal(computeTicketDueAt(tue, 'HIGH').toISOString(), '2026-10-20T23:00:00.000Z');
  process.env.SUPPORT_BUSINESS_HOURS = 'Mon-Fri 09:00-17:00';
  process.env.BUSINESS_TIMEZONE = 'Europe/Amsterdam';
  // Office closed at 17:00 → 8 business hours run Wednesday 09:00-17:00.
  assert.equal(computeTicketDueAt(tue, 'HIGH').toISOString(), '2026-10-21T15:00:00.000Z');
});

test('ticket e-mails: deep link, reply-on-the-ticket wording, reopen date, escaping, no echo for strangers', () => {
  process.env.SITE_NAME = 'Labtodate';
  process.env.BUSINESS_TIMEZONE = 'UTC';
  const status = ticketStatusMail({
    ref: 'TKT-2026-ABC123', subject: '<b>Broken</b> pump', status: 'CLOSED',
    href: 'https://labtodate.com/support/t/tok', reopenUntil: new Date('2026-11-01T10:00:00Z'),
  });
  assert.match(status, /is closed/);
  assert.match(status, /1 Nov 2026/);
  assert.match(status, /href="https:\/\/labtodate\.com\/support\/t\/tok"/);
  assert.ok(status.includes('&lt;b&gt;Broken&lt;/b&gt;'));
  assert.ok(!status.includes('<b>Broken</b>'));

  const reply = staffReplyMail({
    ref: 'TKT-2026-ABC123', subject: 'Pump', body: 'Line 1\nLine 2', attachments: 2,
    href: 'https://labtodate.com/app/support?open=TKT-2026-ABC123#TKT-2026-ABC123', linkValidUntil: null,
  });
  assert.match(reply, /Reply on your ticket page/);
  assert.match(reply, /Line 1<br>Line 2/);
  assert.match(reply, /2 attachments/);
  assert.match(reply, /open=TKT-2026-ABC123/);

  const ack = ticketReceivedMail({
    ref: 'TKT-2026-ABC123', name: 'Mallory', subject: 'Win a prize', body: 'Click evil.example', echo: false,
    guest: true, href: 'https://labtodate.com/support/t/tok', attachments: 0,
  });
  assert.ok(!ack.includes('evil.example') && !ack.includes('Win a prize') && !ack.includes('Mallory'));
  assert.match(ack, /replies within 1 business day/);
  process.env.SUPPORT_REPLY_PROMISE = 'none';
  const noPromise = ticketReceivedMail({
    ref: 'TKT-2026-ABC123', name: 'Ann', subject: 'S', body: 'B', echo: true, guest: false, href: 'x', attachments: 1,
  });
  assert.ok(!/replies within/.test(noPromise));
  assert.match(noPromise, /We’re on it, Ann/);
});
