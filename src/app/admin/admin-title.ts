import type { Metadata } from 'next';
import { hasCapability } from '@/lib/auth-server';

/**
 * <title> for an admin detail page ("Order L2D-2026-ABC123 · Admin" instead
 * of the generic "Admin"). Metadata resolves alongside — not after — the
 * layout's sign-in check, so the record is only looked up for an admin who
 * holds `cap`; anyone else (or a missing record) gets the generic `fallback`.
 */
export async function adminDetailTitle(
  cap: string,
  fallback: string,
  lookup: () => Promise<string | null | undefined>,
): Promise<Metadata> {
  try {
    if (await hasCapability(cap)) {
      const title = await lookup();
      if (title) return { title };
    }
  } catch {
    /* the page itself reports real failures — keep the generic title */
  }
  return { title: fallback };
}
