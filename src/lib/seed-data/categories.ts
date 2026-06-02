import {
  Beaker,
  Microscope,
  TestTubes,
  ScanLine,
  Activity,
  FlaskConical,
  Gauge,
  Stethoscope,
  Cog,
  Database,
  type LucideIcon,
} from 'lucide-react';

export interface CategoryItem {
  slug: string;
  name: string;
  description: string;
  count: number;
  icon: LucideIcon;
}

export const CATEGORIES: CategoryItem[] = [
  { slug: 'general-lab',       name: 'General Laboratory',    description: 'Standard lab workhorses',           count: 1240, icon: Beaker },
  { slug: 'analytical',        name: 'Analytical Instruments', description: 'Spectrometers, HPLC, GC',          count: 892,  icon: ScanLine },
  { slug: 'biotech',           name: 'Biotech & Life Sciences', description: 'PCR, sequencers, incubators',     count: 1567, icon: TestTubes },
  { slug: 'microscopy',        name: 'Microscopy',             description: 'Optical, electron, confocal',      count: 432,  icon: Microscope },
  { slug: 'centrifugation',    name: 'Centrifugation',         description: 'Ultra, micro, refrigerated',       count: 318,  icon: Activity },
  { slug: 'chromatography',    name: 'Chromatography',         description: 'HPLC, GC, IC, FPLC',               count: 276,  icon: FlaskConical },
  { slug: 'test-measurement',  name: 'Test & Measurement',     description: 'Calibration, leak testing',        count: 511,  icon: Gauge },
  { slug: 'medical',           name: 'Medical Equipment',      description: 'Diagnostics & clinical',           count: 384,  icon: Stethoscope },
  { slug: 'process',           name: 'Process Equipment',      description: 'Bioreactors, boilers, pumps',      count: 245,  icon: Cog },
  { slug: 'data-software',     name: 'Data & Software',        description: 'LIMS, ELN, data systems',          count: 138,  icon: Database },
];
