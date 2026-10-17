/**
 * Admin capability model.
 *
 * Anyone with role=ADMIN AND adminCaps containing '*' is a super-admin and
 * can do everything. Scoped admins get a list like ['tickets:*', 'orders:view']
 * — granular per-section permissions instead of "all admins can do anything".
 *
 * Matching rules:
 *  - '*'              → matches everything
 *  - 'orders:*'       → matches any 'orders:<x>'
 *  - 'orders:refund'  → exact match only
 *
 * Granting rules (who may give which capability to whom) live in
 * {@link capsChangeProblems} so the server actions and the UI share them.
 */

export const CAPABILITIES = [
  // Orders
  'orders:view',
  'orders:fulfil',
  'orders:refund',
  // Hard delete: only granted to super-admin by default (via `*`). Archive
  // is the everyday op; `orders:delete` is the irreversible escalation.
  'orders:delete',
  // Money: revenue figures, payment ledger, exports.
  'finance:view',
  'finance:manage',
  'finance:export',
  // Quotes / sourcing
  'quotes:view',
  'quotes:reply',
  'quotes:proforma',
  'quotes:status',           // decline / close / reopen (accepting an offer is the buyer's own step)
  'quotes:assign',           // reassign or claim from one seller/admin to another
  'quotes:archive',          // soft archive + restore
  'quotes:delete',           // irreversible — super-admin only by default
  // Sell submissions (broker intake)
  'sell:view',
  'sell:reply',
  'sell:status',
  // Support tickets
  'tickets:view',
  'tickets:reply',
  'tickets:status',
  'tickets:assign',         // claim / transfer / mention
  'tickets:archive',        // soft archive + restore
  'tickets:delete',         // irreversible — super-admin only by default
  // Messages (buyer↔seller threads)
  'messages:view',
  'messages:reply',
  // Catalog
  'products:view',
  'products:approve',
  'products:edit',
  'categories:manage',
  // People
  'users:view',
  'users:manage', // change role / grant caps (only caps the granter holds)
  'companies:manage',
  'gdpr:manage', // data-subject requests: export / anonymise on someone's behalf
  // Compliance (export control / sanctions holds)
  'compliance:clear',
  // Content & marketing
  'content:write', // blog, wiki
  'content:cms', // testimonials, case studies, lab rental, homepage, in-app announcements
  'marketing:send', // e-mail an announcement / offer to customers
  // System
  'settings:view',
  'settings:write',
  'security:manage', // security policy: 2FA, lockouts, sessions, backups
  'analytics:view',
  'audit:view',
  'errors:view',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Plain-language meaning of each capability, shown next to the checkbox. */
export const CAPABILITY_INFO: Record<Capability, string> = {
  'orders:view': 'See orders, buyers on orders and payment receipts',
  'orders:fulfil': 'Pack, ship and update orders',
  'orders:refund': 'Refund and cancel paid orders',
  'orders:delete': 'Permanently delete orders (irreversible)',
  'finance:view': 'See revenue, totals and other money figures',
  'finance:manage': 'Register payments and credit terms',
  'finance:export': 'Download accounting exports',
  'quotes:view': 'See quote requests and the buyers behind them',
  'quotes:reply': 'Reply on quote threads',
  'quotes:proforma': 'Send offers / proformas',
  'quotes:status': 'Decline, close or reopen quotes',
  'quotes:assign': 'Assign quotes to suppliers / staff',
  'quotes:archive': 'Archive and restore quotes',
  'quotes:delete': 'Permanently delete quotes (irreversible)',
  'sell:view': 'See equipment offers from sellers (incl. their contact and bank details)',
  'sell:reply': 'Reply to sellers',
  'sell:status': 'Change acquisition status',
  'tickets:view': 'See support tickets',
  'tickets:reply': 'Reply to tickets',
  'tickets:status': 'Change ticket status',
  'tickets:assign': 'Claim / transfer tickets',
  'tickets:archive': 'Archive and restore tickets',
  'tickets:delete': 'Permanently delete tickets (irreversible)',
  'messages:view': 'Read buyer ↔ supplier conversations',
  'messages:reply': 'Reply in buyer ↔ supplier conversations',
  'products:view': 'See the catalog admin',
  'products:approve': 'Approve / reject listings',
  'products:edit': 'Edit products and brands',
  'categories:manage': 'Edit categories',
  'users:view': 'See user accounts',
  'users:manage': 'Suspend users, change roles and grant permissions you hold yourself',
  'companies:manage': 'Manage shops & suppliers',
  'gdpr:manage': 'Handle GDPR requests for customers',
  'compliance:clear': 'Release export-control / sanctions holds',
  'content:write': 'Write blog and wiki',
  'content:cms': 'Edit site content and post in-app announcements',
  'marketing:send': 'E-mail announcements and offers to customers',
  'settings:view': 'See settings',
  'settings:write': 'Change settings (bank, company, e-mail, …)',
  'security:manage': 'Change the security policy (2FA, lockouts, sessions, backups)',
  'analytics:view': 'See traffic and conversion analytics',
  'audit:view': 'Read the audit log',
  'errors:view': 'Read the error log',
};

/**
 * Capabilities only a super-admin ('*') may hand out: whoever holds one of
 * these can take over the console (users:manage → grant, settings:write →
 * bank details / mail server, security:manage → switch off 2FA, gdpr:manage →
 * bulk personal data).
 */
export const SUPER_ADMIN_ONLY_CAPS = ['*', 'users:manage', 'settings:write', 'security:manage', 'gdpr:manage'] as const;

/**
 * Named bundles so a super-admin can grant a common role in one click.
 * '*' = full access.
 */
export const CAPABILITY_PRESETS: Record<string, { label: string; caps: string[] }> = {
  SUPER_ADMIN: { label: 'Super admin (everything)', caps: ['*'] },
  OPS: {
    label: 'Operations (orders, quotes, sell, messages)',
    caps: [
      'orders:view',
      'orders:fulfil',
      'quotes:view',
      'quotes:reply',
      'quotes:proforma',
      'sell:view',
      'sell:reply',
      'sell:status',
      'messages:view',
      'messages:reply',
      'analytics:view',
    ],
  },
  FINANCE: {
    label: 'Finance (revenue, refunds, exports)',
    caps: [
      'orders:view',
      'orders:refund',
      'finance:view',
      'finance:manage',
      'finance:export',
      'analytics:view',
      'settings:view',
      'audit:view',
    ],
  },
  SUPPORT: {
    label: 'Support (tickets only)',
    // No tickets:delete — irreversible deletes stay with super-admins.
    caps: ['tickets:view', 'tickets:reply', 'tickets:status', 'tickets:assign', 'tickets:archive', 'users:view'],
  },
  CONTENT: {
    label: 'Content (blog, wiki, CMS)',
    caps: ['content:write', 'content:cms'],
  },
  MARKETING: {
    label: 'Marketing (announcements + offer e-mails)',
    caps: ['content:cms', 'marketing:send'],
  },
  CATALOG: {
    label: 'Catalog (products + categories)',
    caps: ['products:view', 'products:approve', 'products:edit', 'categories:manage'],
  },
};

/** Does this set of caps satisfy the required capability? */
export function capsAllow(caps: string[] | null | undefined, required: string): boolean {
  if (!caps || caps.length === 0) return false;
  if (caps.includes('*')) return true;
  if (caps.includes(required)) return true;
  // Section wildcard, e.g. 'orders:*' allows 'orders:refund'.
  const section = required.split(':')[0];
  if (caps.includes(`${section}:*`)) return true;
  return false;
}

/** Convenience: any cap in the section means "can see this admin section". */
export function capsAllowSection(caps: string[] | null | undefined, section: string): boolean {
  if (!caps || caps.length === 0) return false;
  if (caps.includes('*') || caps.includes(`${section}:*`)) return true;
  return caps.some((c) => c.startsWith(`${section}:`));
}

/** A capability string we recognise: a known cap, '*', or '<section>:*' of a known section. */
export function isKnownCapability(cap: string): boolean {
  if (cap === '*') return true;
  if ((CAPABILITIES as readonly string[]).includes(cap)) return true;
  const m = /^([a-z]+):\*$/.exec(cap);
  return !!m && CAPABILITIES.some((c) => c.startsWith(`${m[1]}:`));
}

/** True when granting `cap` hands out something only a super-admin may give. */
function isSuperOnly(cap: string): boolean {
  if ((SUPER_ADMIN_ONLY_CAPS as readonly string[]).includes(cap)) return true;
  // A section wildcard covering a super-only cap ('users:*', 'settings:*' …).
  const m = /^([a-z]+):\*$/.exec(cap);
  return !!m && SUPER_ADMIN_ONLY_CAPS.some((c) => c.startsWith(`${m[1]}:`));
}

/**
 * Can an actor holding `actorCaps` hand out `cap`? Only caps they hold
 * themselves (a section wildcard needs the same wildcard), and the
 * super-admin-only ones need '*'.
 */
export function canGrantCapability(actorCaps: string[], cap: string): boolean {
  if (actorCaps.includes('*')) return true;
  if (isSuperOnly(cap)) return false;
  if (cap.endsWith(':*')) return actorCaps.includes(cap);
  return capsAllow(actorCaps, cap);
}

export type CapsChangeInput = {
  actorId: string;
  actorCaps: string[];
  targetId: string;
  /** The target's role and caps before the change. */
  targetRole: string;
  targetCaps: string[];
  /** Caps after the change (role stays/becomes ADMIN), or [] for a demotion. */
  nextCaps: string[];
  /** Unsuspended super-admins OTHER than the target. */
  otherActiveSuperAdmins: number;
};

/**
 * Server-side rules for any change to an admin's access (caps edit, role
 * change, suspension, deletion). Returns the reasons it is refused — empty
 * when allowed. Pure, so it is unit-tested (scripts/test-security.ts).
 */
export function capsChangeProblems(i: CapsChangeInput): string[] {
  const problems: string[] = [];
  if (i.actorId === i.targetId) {
    problems.push('You can’t change your own access — ask another super-admin.');
    return problems;
  }
  if (!capsAllow(i.actorCaps, 'users:manage')) {
    problems.push('You need the users:manage permission.');
    return problems;
  }
  // Someone with more access than you can only be changed by someone with at
  // least that access (a scoped admin can't strip or demote a super-admin).
  if (i.targetRole === 'ADMIN') {
    const above = i.targetCaps.filter((c) => !canGrantCapability(i.actorCaps, c));
    if (above.length) {
      problems.push(
        `This admin holds ${above.map((c) => `“${c}”`).join(', ')}, which you can’t grant — only a super-admin can change their access.`,
      );
      return problems;
    }
  }
  const unknown = i.nextCaps.filter((c) => !isKnownCapability(c));
  if (unknown.length) problems.push(`Unknown permission ${unknown.map((c) => `“${c}”`).join(', ')}.`);
  const notGrantable = i.nextCaps.filter((c) => isKnownCapability(c) && !canGrantCapability(i.actorCaps, c));
  if (notGrantable.length) {
    problems.push(
      notGrantable.some((c) => isSuperOnly(c))
        ? `Only a super-admin can grant ${notGrantable.map((c) => `“${c}”`).join(', ')}.`
        : `You can only grant permissions you hold yourself — you don’t hold ${notGrantable.map((c) => `“${c}”`).join(', ')}.`,
    );
  }
  const wasSuper = i.targetRole === 'ADMIN' && i.targetCaps.includes('*');
  if (wasSuper && !i.nextCaps.includes('*') && i.otherActiveSuperAdmins < 1) {
    problems.push('This is the last active super-admin — make someone else super-admin first.');
  }
  return problems;
}
