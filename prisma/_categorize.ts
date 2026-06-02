/**
 * Single source of truth for the clean lab2date category taxonomy.
 * Used by recategorize.ts (fix existing data) AND import-woo.ts (so new
 * shop imports never reintroduce model-number junk categories).
 */

export interface CleanCat {
  slug: string;
  name: string;
}

// Order = display order. Keep stable; slugs are referenced in URLs.
export const CLEAN_CATEGORIES: CleanCat[] = [
  { slug: 'hplc-lc', name: 'HPLC / LC' },
  { slug: 'gc', name: 'Gas Chromatography (GC)' },
  { slug: 'mass-spec', name: 'Mass Spectrometry' },
  { slug: 'spectroscopy', name: 'Spectroscopy' },
  { slug: 'autosamplers', name: 'Autosamplers' },
  { slug: 'pumps-fluidics', name: 'Pumps & Fluidics' },
  { slug: 'detectors', name: 'Detectors' },
  { slug: 'vacuum-gas', name: 'Vacuum & Gas Generation' },
  { slug: 'microscopy', name: 'Microscopy & Imaging' },
  { slug: 'centrifuges', name: 'Centrifuges' },
  { slug: 'general-lab', name: 'Sample Prep & General Lab' },
  { slug: 'parts-modules', name: 'Parts, Modules & Consumables' },
];

// First rule that matches (title + hint) wins. Specific instruments are
// matched before the generic "parts" fallback.
const RULES: { slug: string; re: RegExp }[] = [
  { slug: 'mass-spec', re: /\b(lc[\s\-/]*ms|gc[\s\-/]*ms|ms[\s\-/]*ms|lcms|gcms|mass spec|spectromet|polaris\s*q|micromass|tof|orbitrap|triple\s*quad|\bqqq\b|finnigan|quattro|xevo|icp[\s\-]*ms)\b/i },
  { slug: 'spectroscopy', re: /\b(aas|atomic absorption|ft[\s\-]?ir|ftir|uv[\s\-/]*vis|uv\/vis|fluorescen|spectrophotomet|raman|\bnmr\b|icp[\s\-]*oes|optical emission|\baa\b)\b/i },
  { slug: 'gc', re: /\b(gc\b|gas\s*chromatograph|6890|6850|5890|3800|trace\s*gc|\batd\b|thermal desorb|headspace|gc[\s\-]*pal)\b/i },
  { slug: 'hplc-lc', re: /\b(hplc|uplc|\blc\b|alliance|acquity|nexera|prominence|infinity|1100|1200|1260|2695|2690|2487|2996|2488|600\s*series|rheodyne|breeze|empower)\b/i },
  { slug: 'autosamplers', re: /\b(autosampler|auto[\s\-]*sampler|sampler|717|\bals\b|carousel|\bpal\b|triplus|surveyor autosampler|series 200 autosampler)\b/i },
  { slug: 'detectors', re: /\b(detector|\bdad\b|\bpda\b|\bfld\b|\belsd\b|\bcad\b|\brid\b|diode array|refractive index|mux_uv|fluorescence detector)\b/i },
  { slug: 'pumps-fluidics', re: /\b(pump|degasser|gradient|solvent (manager|delivery)|fluidic|syringe pump|peristaltic|micro pump)\b/i },
  { slug: 'vacuum-gas', re: /\b(vacuum|edwards|gas generat|nitrogen generat|hydrogen generat|turbo\s*pump|roughing pump|backing pump)\b/i },
  { slug: 'microscopy', re: /\b(microscop|confocal|axio|imager|imaging system)\b/i },
  { slug: 'centrifuges', re: /\b(centrifug|rotor|sorvall|allegra|avanti)\b/i },
  { slug: 'general-lab', re: /\b(balance|weigh|\bscale\b|incubat|shaker|water bath|\boven\b|\bpcr\b|thermocycler|pipette|evaporat|concentrat|sample prep|homogeniz|\bmill\b|stirrer|hotplate)\b/i },
  { slug: 'parts-modules', re: /\b(part|module|board|valve|seal|\bkit\b|consumable|spare|interface|controller|power supply|component|fitting|capillary|column|lamp|fuse|cable|filter|tubing|adapter|bracket)\b/i },
];

export function categorize(title: string, hint = ''): string {
  const hay = `${title} ${hint}`;
  for (const r of RULES) if (r.re.test(hay)) return r.slug;
  return 'parts-modules'; // safe default
}
