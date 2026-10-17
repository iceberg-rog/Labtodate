/**
 * Which generic instrument drawing (components/illustrations/instruments) may
 * stand in for a listing without photos — only one that fits its category, and
 * always labelled "not the actual item" (NoPhoto). Pure and client-safe.
 */

export const ILLUSTRATION_NAMES = ['microscope', 'centrifuge', 'pcr', 'hplc', 'massspec', 'balance', 'gc', 'autosampler', 'detector'] as const;
export type IllustrationKey = (typeof ILLUSTRATION_NAMES)[number];

const BY_CATEGORY: Record<string, IllustrationKey> = {
  gc: 'gc',
  'hplc-lc': 'hplc',
  'mass-spec': 'massspec',
  autosamplers: 'autosampler',
  detectors: 'detector',
  centrifuges: 'centrifuge',
  microscopy: 'microscope',
};

/** The drawing for a category slug, or null when none fits (→ "Photo on request"). */
export function illustrationForCategory(slug: string | null | undefined): IllustrationKey | null {
  return slug ? BY_CATEGORY[slug] ?? null : null;
}

/** A stored illustration name, or null when it is not one of ours. */
export function knownIllustration(name: string | null | undefined): IllustrationKey | null {
  return name && (ILLUSTRATION_NAMES as readonly string[]).includes(name) ? (name as IllustrationKey) : null;
}
