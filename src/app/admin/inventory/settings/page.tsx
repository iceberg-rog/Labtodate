import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { prisma } from '@/lib/db';
import { requireCapability } from '@/lib/auth-server';
import { INVENTORY_SETTING_DEFS, getInventorySettings } from '@/lib/inventory/settings';
import { InventorySettingsForm, type SettingField } from '@/components/admin/inventory/InventorySettingsForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Inventory settings' };

export default async function InventorySettingsPage() {
  await requireCapability('settings:write');
  const [values, categories, stored] = await Promise.all([
    getInventorySettings(),
    prisma.category.findMany({ orderBy: { name: 'asc' }, select: { name: true, slug: true } }),
    prisma.setting.findMany({ where: { key: { startsWith: 'INVENTORY_' } }, select: { key: true } }),
  ]);
  const storedKeys = new Set(stored.map((s) => s.key));
  const fields: SettingField[] = INVENTORY_SETTING_DEFS.map((d) => ({
    key: d.key,
    group: d.group,
    label: d.label,
    hint: d.hint,
    type: d.type,
    options:
      d.type === 'enum'
        ? d.options.map((o) => ({ value: o.value, label: o.label }))
        : d.type === 'category'
          ? [{ value: '', label: '(none: refuse such rows)' }, ...categories.map((c) => ({ value: c.slug, label: c.name }))]
          : undefined,
    min: d.type === 'int' ? d.min : undefined,
    max: d.type === 'int' ? d.max : undefined,
    suffix: d.type === 'int' && 'suffix' in d ? d.suffix : undefined,
    maxLength: d.type === 'text' ? d.maxLength : undefined,
    value: String((values as Record<string, unknown>)[d.key]),
    defaultValue: String(d.default),
    isDefault: !storedKeys.has(d.key),
  }));
  return (
    <div className="space-y-5 max-w-4xl">
      <div>
        <Link href="/admin/inventory" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" /> Inventory
        </Link>
        <h1 className="text-3xl font-bold tracking-tight mt-2">Inventory settings</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Every rule the inventory follows. Changes apply to the site at once. Each change is written to the audit log.
        </p>
      </div>
      <InventorySettingsForm fields={fields} />
    </div>
  );
}
