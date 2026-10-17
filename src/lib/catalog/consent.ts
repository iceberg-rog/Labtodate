import type { Prisma } from '@prisma/client';
import { getCatalogPolicy } from '@/lib/catalog/policy';

/**
 * Endorsements (testimonials, case studies) are public only with recorded
 * consent while REQUIRE_CONSENT_TO_PUBLISH is on (Settings → Catalog & claims,
 * default on). Use these filters on every public read.
 */
export async function publicTestimonialWhere(): Promise<Prisma.TestimonialWhereInput> {
  const { requireConsentToPublish } = await getCatalogPolicy();
  return { published: true, ...(requireConsentToPublish ? { consentAt: { not: null }, consentBy: { not: null } } : {}) };
}

export async function publicCaseStudyWhere(): Promise<Prisma.CaseStudyWhereInput> {
  const { requireConsentToPublish } = await getCatalogPolicy();
  return { status: 'PUBLISHED', ...(requireConsentToPublish ? { consentAt: { not: null }, consentBy: { not: null } } : {}) };
}

/** Consent fields from an admin form: who approved, the date, how (note). */
export function consentFromForm(formData: FormData): { consentBy: string | null; consentAt: Date | null; consentNote: string | null } {
  const by = String(formData.get('consentBy') ?? '').trim().slice(0, 200);
  const at = String(formData.get('consentAt') ?? '').trim();
  const note = String(formData.get('consentNote') ?? '').trim().slice(0, 500);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(at) ? new Date(`${at}T12:00:00Z`) : null;
  return {
    consentBy: by || null,
    consentAt: date && !Number.isNaN(date.getTime()) && date.getTime() <= Date.now() + 86_400_000 ? date : null,
    consentNote: note || null,
  };
}

export function hasConsent(r: { consentBy: string | null; consentAt: Date | null }): boolean {
  return !!(r.consentBy && r.consentAt);
}

export const CONSENT_MISSING_MESSAGE =
  'Not published: record who approved this endorsement and when (consent). Settings → Catalog & claims requires it — endorsements without proof of consent are prohibited under the EU Omnibus rules.';
