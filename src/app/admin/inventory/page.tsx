import { prisma } from '@/lib/db';
import { getAdminCaps, requireCapability } from '@/lib/auth-server';
import { capsAllow } from '@/lib/capabilities';
import { loadInventoryRows } from '@/lib/inventory/rows';
import { getInventorySettings } from '@/lib/inventory/settings';
import { InventoryGrid } from '@/components/admin/inventory/InventoryGrid';
import type { QuickFilter } from '@/components/admin/inventory/grid-utils';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Inventory' };

const FILTERS: QuickFilter[] = ['all', 'low', 'out', 'reserved', 'nocost', 'lowmargin', 'offsite', 'nosku'];

export default async function InventoryPage(props: { searchParams: Promise<{ scope?: string; focus?: string; filter?: string; q?: string }> }) {
  const sp = await props.searchParams;
  await requireCapability('inventory:view');
  const caps = await getAdminCaps();
  const perms = {
    edit: capsAllow(caps, 'inventory:edit'),
    cost: capsAllow(caps, 'inventory:cost'),
    approve: capsAllow(caps, 'products:approve'),
    import: capsAllow(caps, 'inventory:import'),
    settings: capsAllow(caps, 'settings:write'),
  };
  const scope = sp.scope === 'all' ? 'all' : 'own';
  const [rows, settings, suppliers, categories, brands, locations] = await Promise.all([
    loadInventoryRows({ scope, canCost: perms.cost }),
    getInventorySettings(),
    prisma.supplier.findMany({ orderBy: { name: 'asc' }, select: { name: true } }),
    prisma.category.findMany({ orderBy: { name: 'asc' }, select: { name: true, slug: true } }),
    prisma.brand.findMany({ orderBy: { name: 'asc' }, select: { name: true } }),
    prisma.productInventory.findMany({ where: { location: { not: null } }, distinct: ['location'], select: { location: true }, take: 500 }),
  ]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Inventory</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Every item you stock, in one sheet. Selling price and stock are the listing&apos;s own: a change shows on the site at once.
          Purchase cost, supplier, location and notes are private.
        </p>
      </div>
      <InventoryGrid
        initialRows={rows}
        scope={scope}
        suppliers={suppliers.map((s) => s.name)}
        categories={categories}
        brands={brands.map((b) => b.name)}
        locations={locations.map((l) => l.location!).sort((a, b) => a.localeCompare(b))}
        perms={perms}
        rules={{
          lowDefault: settings.INVENTORY_LOW_STOCK_DEFAULT,
          minMarginPct: settings.INVENTORY_MIN_MARGIN_PCT,
          newMode: settings.INVENTORY_NEW_MODE,
          newCondition: settings.INVENTORY_NEW_CONDITION,
        }}
        focusId={sp.focus ?? null}
        initialQuery={(sp.q ?? '').slice(0, 100)}
        initialFilter={FILTERS.includes(sp.filter as QuickFilter) ? (sp.filter as QuickFilter) : undefined}
      />
    </div>
  );
}
