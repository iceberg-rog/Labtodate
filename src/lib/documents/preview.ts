import { prisma } from '@/lib/db';
import { cleanLabels, cleanOptions, cleanTexts, cleanGeneral, getGeneral, getLabels, getOptions, getTexts, getVatSettings } from './config';
import { sampleSnapshot, type SampleKind } from './build';
import { paymentRequestSnapshot, snapshotOf } from './issue';
import type { DocKind, DocSnapshot, Lang } from './types';

/**
 * Data for the admin's live preview: sample data or a real issued document,
 * re-rendered with the CURRENT (or the admin's unsaved) templates and marked
 * "Preview". The real document itself is never changed by this.
 */

export interface PreviewOverride {
  texts?: Record<string, unknown>;
  labels?: Record<string, unknown>;
  options?: Record<string, unknown>;
  general?: Record<string, unknown>;
}

export async function previewSnapshot(args: { kind: DocKind; lang: Lang; source: string; override?: PreviewOverride | Record<string, unknown> }): Promise<DocSnapshot> {
  const o = (args.override ?? {}) as PreviewOverride;
  // Unsaved edits are validated exactly like a save; invalid ones fall back
  // to the stored version so the preview never shows a broken document.
  const safe = <T,>(fn: () => T, fallback: () => Promise<T>): Promise<T> => {
    try {
      return Promise.resolve(fn());
    } catch {
      return fallback();
    }
  };
  const texts = o.texts ? await safe(() => cleanTexts(args.kind, o.texts!), () => getTexts(args.kind, args.lang)) : await getTexts(args.kind, args.lang);
  const labels = o.labels ? await safe(() => cleanLabels(o.labels!), () => getLabels(args.lang)) : await getLabels(args.lang);
  const options = o.options ? await safe(() => cleanOptions(args.kind, o.options!), () => getOptions(args.kind)) : await getOptions(args.kind);
  const general = o.general ? await safe(() => cleanGeneral(o.general!), () => getGeneral()) : await getGeneral();
  const override = { texts, labels, options, accent: general.accent };

  const [type, id] = args.source.split(':');
  if (type === 'doc' && id) {
    const doc = await prisma.issuedDocument.findUnique({ where: { id } });
    if (doc && doc.kind === args.kind) {
      const base = snapshotOf(doc);
      return { ...base, lang: args.lang, texts, labels, options, accent: general.accent, preview: true };
    }
  }
  if (type === 'order' && id) {
    const snap = await paymentRequestSnapshot(id);
    if (snap) return { ...snap, kind: args.kind, lang: args.lang, texts, labels, options, accent: general.accent, preview: true };
  }
  const sample = (['nl', 'eu', 'export'].includes(id ?? '') ? id : 'nl') as SampleKind;
  return sampleSnapshot({ kind: args.kind, lang: args.lang, sample, override, vatSettings: await getVatSettings() });
}

/** Real documents the preview can use, newest first. */
export async function previewSources(kind: DocKind): Promise<{ value: string; label: string }[]> {
  const samples = [
    { value: 'sample:nl', label: 'Sample — Dutch business (21% VAT)' },
    { value: 'sample:eu', label: 'Sample — German business (reverse charge)' },
    { value: 'sample:export', label: 'Sample — US customer (export 0%)' },
  ];
  try {
    const docs = await prisma.issuedDocument.findMany({
      where: { kind },
      orderBy: { issuedAt: 'desc' },
      take: 12,
      select: { id: true, number: true, revision: true, snapshot: true },
    });
    return [
      ...samples,
      ...docs.map((d) => {
        const s = d.snapshot as unknown as DocSnapshot;
        return { value: `doc:${d.id}`, label: `${d.number}${d.revision > 1 ? ` rev ${d.revision}` : ''} — ${s.customer?.company || s.customer?.name || ''}` };
      }),
    ];
  } catch {
    return samples;
  }
}
