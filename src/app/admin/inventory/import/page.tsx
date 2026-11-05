import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { COLUMNS } from '@/lib/inventory/fields';
import { TARGET_LABEL, type Target } from '@/lib/inventory/import';
import { ImportWizard } from '@/components/admin/inventory/ImportWizard';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Import inventory' };

export default async function InventoryImportPage() {
  await requireCapability('inventory:import');
  const targets: { value: Target; label: string }[] = [
    { value: 'ignore', label: TARGET_LABEL.ignore },
    ...COLUMNS.filter((c) => c.editable || c.key === 'id').map((c) => ({ value: c.key as Target, label: c.key === 'id' ? 'ID' : c.header })),
    ...(['summary', 'description', 'specs', 'year'] as const).map((k) => ({ value: k as Target, label: TARGET_LABEL[k] })),
  ];
  return (
    <div className="space-y-5 max-w-6xl">
      <div>
        <Link href="/admin/inventory" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" /> Inventory
        </Link>
        <h1 className="text-3xl font-bold tracking-tight mt-2">Import a spreadsheet</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Upload an Excel (.xlsx) or CSV file. You first see exactly what would change, line by line. Nothing is saved until you click Apply.
        </p>
      </div>
      <ImportWizard targets={targets} />
    </div>
  );
}
