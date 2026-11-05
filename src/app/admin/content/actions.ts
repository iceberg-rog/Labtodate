'use server';

import { revalidatePath } from 'next/cache';
import { getServerSession, hasCapability } from '@/lib/auth-server';
import { audit } from '@/lib/observability';
import { saveEntry } from '@/lib/cms/store';
import { groupKey, saveGroup, SiteTextError } from '@/lib/site/content';
import { siteGroup } from '@/lib/site/defs';

export type SiteActionResult = { ok: boolean; message: string; problems?: string[] };

async function who() {
  const session = await getServerSession();
  if (!session?.user || session.user.role !== 'ADMIN') return null;
  if (!(await hasCapability('content:cms'))) return null;
  return { id: session.user.id, email: session.user.email };
}

export async function saveSiteGroup(id: string, data: Record<string, unknown>): Promise<SiteActionResult> {
  const actor = await who();
  if (!actor) return { ok: false, message: 'Your admin account lacks the “content:cms” permission.' };
  try {
    const v = await saveGroup(id, data, actor);
    await audit('content.site.save', id, `v${v}`).catch(() => {});
    revalidatePath('/', 'layout');
    return { ok: true, message: `Saved (version ${v}). The site shows it within a few seconds.` };
  } catch (e) {
    if (e instanceof SiteTextError) return { ok: false, message: 'Nothing was saved. Fix these first:', problems: e.problems };
    return { ok: false, message: e instanceof Error ? e.message : 'Saving failed.' };
  }
}

export async function resetSiteGroup(id: string): Promise<SiteActionResult> {
  const actor = await who();
  if (!actor) return { ok: false, message: 'Your admin account lacks the “content:cms” permission.' };
  const g = siteGroup(id);
  if (!g) return { ok: false, message: 'Unknown group.' };
  const v = await saveEntry(groupKey(id), Object.fromEntries(g.fields.map((f) => [f.key, f.default])), actor, 'reset to default');
  revalidatePath('/', 'layout');
  return { ok: true, message: `Back to the built-in texts (version ${v}). The previous version stays in History.` };
}
