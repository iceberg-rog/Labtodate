/**
 * The fixed icon set a category can carry (Category.icon, Admin → Categories):
 * shown next to the category on the homepage instruments station. Names are
 * lucide icon names (src/components/home/CategoryIcon.tsx maps them); an icon
 * not in this list is ignored. Pure data.
 */
export const CATEGORY_ICONS = [
  { value: 'FlaskConical', label: 'Flask' },
  { value: 'Beaker', label: 'Beaker' },
  { value: 'TestTubes', label: 'Test tubes' },
  { value: 'Pipette', label: 'Pipette' },
  { value: 'Microscope', label: 'Microscope' },
  { value: 'Atom', label: 'Atom (mass spectrometry)' },
  { value: 'Activity', label: 'Signal (spectroscopy, detectors)' },
  { value: 'ChartLine', label: 'Chromatogram' },
  { value: 'Waves', label: 'Waves' },
  { value: 'Dna', label: 'DNA (life sciences)' },
  { value: 'Biohazard', label: 'Biosafety' },
  { value: 'HeartPulse', label: 'Medical' },
  { value: 'Stethoscope', label: 'Stethoscope' },
  { value: 'Thermometer', label: 'Thermometer' },
  { value: 'Snowflake', label: 'Cold storage' },
  { value: 'Flame', label: 'Heating' },
  { value: 'Disc3', label: 'Centrifuge' },
  { value: 'Gauge', label: 'Gauge (test & measurement)' },
  { value: 'Scale', label: 'Balance' },
  { value: 'Droplets', label: 'Fluidics' },
  { value: 'Wind', label: 'Gas & vacuum' },
  { value: 'Filter', label: 'Filtration' },
  { value: 'Zap', label: 'Power' },
  { value: 'Cpu', label: 'Electronics' },
  { value: 'Database', label: 'Data & software' },
  { value: 'Monitor', label: 'Monitor' },
  { value: 'Wrench', label: 'Service & parts' },
  { value: 'Package', label: 'Consumables' },
  { value: 'Boxes', label: 'Modules' },
  { value: 'Factory', label: 'Process equipment' },
  { value: 'Layers', label: 'General' },
] as const;

export type CategoryIconName = (typeof CATEGORY_ICONS)[number]['value'];

export function isCategoryIcon(v: string | null | undefined): v is CategoryIconName {
  return !!v && CATEGORY_ICONS.some((i) => i.value === v);
}
