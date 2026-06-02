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
 */

export const CAPABILITIES = [
  // Orders
  'orders:view',
  'orders:fulfil',
  'orders:refund',
  // Hard delete: only granted to super-admin by default (via `*`). Archive
  // is the everyday op; `orders:delete` is the irreversible escalation.
  'orders:delete',
  // Quotes / sourcing
  'quotes:view',
  'quotes:reply',
  'quotes:proforma',
  'quotes:status',           // accept / decline / close on behalf of buyer or seller
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
  'users:manage', // change role / grant caps
  'companies:manage',
  // Content
  'content:write', // blog, wiki
  'content:cms', // testimonials, case studies, lab rental, homepage, announcements
  // System
  'settings:view',
  'settings:write',
  'analytics:view',
  'audit:view',
  'errors:view',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

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
    label: 'Finance (refunds, analytics, settings:view)',
    caps: ['orders:view', 'orders:refund', 'analytics:view', 'settings:view', 'audit:view'],
  },
  SUPPORT: {
    label: 'Support (tickets only)',
    caps: ['tickets:view', 'tickets:reply', 'tickets:status', 'tickets:delete', 'users:view'],
  },
  CONTENT: {
    label: 'Content (blog, wiki, CMS)',
    caps: ['content:write', 'content:cms'],
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
