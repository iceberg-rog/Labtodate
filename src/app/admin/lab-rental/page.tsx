import { Plus, Trash2, Eye, EyeOff, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { createFacility, deleteFacility, toggleFacility, updateFacility } from '@/app/admin/actions';
import { ConfirmSubmitButton } from '@/components/admin/ConfirmSubmitButton';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Lab rental' };

export default async function AdminLabRentalPage() {
  await requireCapability('content:cms');
  const list = await prisma.labFacility.findMany({ orderBy: { createdAt: 'desc' } });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Lab rental facilities</h1>
        <p className="text-muted-foreground mt-1">
          {list.length} facilit{list.length === 1 ? 'y' : 'ies'} · published ones appear on /lab-rental
        </p>
      </div>

      <form action={createFacility} className="rounded-2xl border border-border bg-card p-5 space-y-4">
        <h2 className="font-semibold">Add facility</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="text-sm font-medium">Name</label>
            <input name="name" required className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder="Munich Analytical Lab" />
          </div>
          <div>
            <label className="text-sm font-medium">City</label>
            <input name="city" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder="Munich" />
          </div>
          <div>
            <label className="text-sm font-medium">Country</label>
            <input name="country" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder="Germany" />
          </div>
          <div>
            <label className="text-sm font-medium">Capabilities (comma-separated)</label>
            <input name="capabilities" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder="HPLC, Mass Spec, PCR" />
          </div>
          <div>
            <label className="text-sm font-medium">Hourly rate (EUR, optional)</label>
            <input name="hourlyRate" type="number" min={0} max={1000000} step="0.01" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder="120" />
          </div>
          <div>
            <label className="text-sm font-medium">Daily rate (EUR, optional)</label>
            <input name="dailyRate" type="number" min={0} max={1000000} step="0.01" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder="850" />
          </div>
        </div>
        <div>
          <label className="text-sm font-medium">Description</label>
          <textarea name="description" rows={4} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder="What this facility offers" />
        </div>
        <Button type="submit" className="rounded-full font-semibold">
          <Plus className="h-4 w-4" /> Add facility
        </Button>
      </form>

      <ul className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
        {list.length === 0 && <li className="p-6 text-sm text-muted-foreground">No facilities yet.</li>}
        {list.map((f) => (
          <li key={f.id} className="p-4 flex items-start gap-4 flex-wrap">
            <div className="flex-1 min-w-0">
              <p className="font-semibold truncate">{f.name}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {[f.city, f.country].filter((v) => v && v !== '—').join(', ') || '—'}
                {f.capabilities.length > 0 && ` · ${f.capabilities.join(', ')}`}
              </p>
            </div>
            <Badge variant={f.isPublished ? 'success' : 'secondary'}>
              {f.isPublished ? 'published' : 'hidden'}
            </Badge>
            <form action={toggleFacility.bind(null, f.id, !f.isPublished)}>
              <Button type="submit" variant="outline" size="sm" className="rounded-full font-medium">
                {f.isPublished ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                {f.isPublished ? 'Hide' : 'Publish'}
              </Button>
            </form>
            <form action={deleteFacility.bind(null, f.id)}>
              <ConfirmSubmitButton
                message={`Delete the facility "${f.name}"? This cannot be undone.`}
                variant="outline"
                size="sm"
                className="rounded-full font-medium text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </ConfirmSubmitButton>
            </form>
            <details className="basis-full">
              <summary className="cursor-pointer select-none w-fit text-xs font-semibold text-primary hover:underline">Edit</summary>
              <form action={updateFacility.bind(null, f.id)} className="mt-3 space-y-3">
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  <input name="name" required defaultValue={f.name} aria-label="Name" placeholder="Name" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                  <input name="city" defaultValue={f.city === '—' ? '' : f.city} aria-label="City" placeholder="City" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                  <input name="country" defaultValue={f.country === '—' ? '' : f.country} aria-label="Country" placeholder="Country" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                  <input name="capabilities" defaultValue={f.capabilities.join(', ')} aria-label="Capabilities (comma-separated)" placeholder="Capabilities (comma-separated)" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                  <input name="hourlyRate" type="number" min={0} max={1000000} step="0.01" defaultValue={f.hourlyRateCents != null ? f.hourlyRateCents / 100 : ''} aria-label="Hourly rate (EUR)" placeholder="Hourly rate (EUR)" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                  <input name="dailyRate" type="number" min={0} max={1000000} step="0.01" defaultValue={f.dailyRateCents != null ? f.dailyRateCents / 100 : ''} aria-label="Daily rate (EUR)" placeholder="Daily rate (EUR)" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                </div>
                <textarea name="description" rows={4} defaultValue={f.description} aria-label="Description" placeholder="Description" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                <Button type="submit" size="sm" className="rounded-full font-semibold">
                  <Save className="h-3.5 w-3.5" /> Save changes
                </Button>
              </form>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
