'use server';

import { changeSupplierCompany, changeUserRole, type AccessResult } from '@/lib/security/user-access';

/**
 * Supplier company of a user (Admin → Users → user → Supplier company). The
 * rules live in src/lib/security/user-access.ts:
 *  - promoteToSupplier: BUYER → internal supplier for the chosen company
 *    (users:manage, step-up like every role change); the user is told;
 *  - linkSupplierCompany: move an internal supplier to another company
 *    (users:manage or companies:manage).
 */
export async function promoteToSupplier(formData: FormData): Promise<AccessResult> {
  const userId = String(formData.get('userId') ?? '');
  const companyId = String(formData.get('companyId') ?? '').trim();
  if (!userId) return { ok: false, message: 'Missing user.' };
  if (!companyId) return { ok: false, message: 'Choose the company this supplier sells for.' };
  return changeUserRole(userId, 'SELLER', null, companyId);
}

export async function linkSupplierCompany(formData: FormData): Promise<AccessResult> {
  const userId = String(formData.get('userId') ?? '');
  const companyId = String(formData.get('companyId') ?? '').trim();
  if (!userId) return { ok: false, message: 'Missing user.' };
  if (!companyId) return { ok: false, message: 'Choose a company.' };
  return changeSupplierCompany(userId, companyId);
}
