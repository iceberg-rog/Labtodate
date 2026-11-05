import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { prisma } from '@/lib/db';
import { getAdminCaps, requireCapability } from '@/lib/auth-server';
import { capsAllow } from '@/lib/capabilities';
import { SupplierManager } from '@/components/admin/inventory/SupplierManager';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Suppliers' };

export default async function SuppliersPage() {
  await requireCapability('inventory:view');
  const caps = await getAdminCaps();
  const suppliers = await prisma.supplier.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { items: true } } },
  });
  return (
    <div className="space-y-5 max-w-5xl">
      <div>
        <Link href="/admin/inventory" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" /> Inventory
        </Link>
        <h1 className="text-3xl font-bold tracking-tight mt-2">Suppliers</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Who you buy parts from. Private: suppliers are never shown on the site (unlike Shops, which have a public page).
          You can also add one by typing a new name in the sheet&apos;s Supplier column.
        </p>
      </div>
      <SupplierManager
        canEdit={capsAllow(caps, 'inventory:edit')}
        suppliers={suppliers.map((s) => ({
          id: s.id,
          name: s.name,
          contactName: s.contactName ?? '',
          email: s.email ?? '',
          phone: s.phone ?? '',
          website: s.website ?? '',
          notes: s.notes ?? '',
          items: s._count.items,
        }))}
      />
    </div>
  );
}
