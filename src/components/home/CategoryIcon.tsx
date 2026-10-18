import {
  Activity, Atom, Beaker, Biohazard, Boxes, ChartLine, Cpu, Database, Disc3, Dna, Droplets, Factory, Filter, Flame, FlaskConical, Gauge,
  HeartPulse, Layers, Microscope, Monitor, Package, Pipette, Scale, Snowflake, Stethoscope, TestTubes, Thermometer, Waves, Wind,
  Wrench, Zap, type LucideIcon,
} from 'lucide-react';
import { isCategoryIcon, type CategoryIconName } from '@/lib/home/category-icons';

const ICONS: Record<CategoryIconName, LucideIcon> = {
  FlaskConical, Beaker, TestTubes, Pipette, Microscope, Atom, Activity, ChartLine, Waves, Dna, Biohazard, HeartPulse, Stethoscope,
  Thermometer, Snowflake, Flame, Disc3, Gauge, Scale, Droplets, Wind, Filter, Zap, Cpu, Database, Monitor, Wrench, Package,
  Boxes, Factory, Layers,
};

/** A category's icon from the fixed set (Category.icon); nothing for an unknown or empty name. */
export function CategoryIcon({ name, className }: { name: string | null | undefined; className?: string }) {
  if (!isCategoryIcon(name)) return null;
  const Icon = ICONS[name];
  return <Icon className={className} aria-hidden />;
}
