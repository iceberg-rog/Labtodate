import ExcelJS from 'exceljs';
import { prisma } from '@/lib/db';
import { BASE_SHEET, DATA_SHEET, EXPORT_MARKER } from './export';
import { COLUMNS, COLUMN_BY_KEY, FIELD_LABEL, type ColumnKey, type EditableField, type InventoryRow } from './fields';
import { loadInventoryRows, partNumberFromSpecs } from './rows';
import type { InventorySettings } from './settings';
import { cleanText, headerKey, parseWholeNumber } from './text';
import {
  applyInventoryChanges,
  createInventoryProduct,
  displayValue,
  findCategory,
  parseFieldValue,
  sameValue,
  type CellChange,
  type WriteContext,
} from './write';

/**
 * Spreadsheet import: read an .xlsx or .csv, match each line to an item, show
 * a before -> after preview, apply only what the admin confirms.
 */

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;

export type Cell = string | number | null;
export type Sheet = {
  format: 'xlsx' | 'csv';
  headers: string[];
  rows: Cell[][];
  /** The spreadsheet line number of each row (header = 1), so messages point at the right line. */
  lineNumbers: number[];
  /** Values at export time, per item id (only in our own .xlsx exports). */
  base: Map<string, Record<string, Cell>> | null;
  exportedAt: string | null;
};

/** Extra columns that are not inventory fields but help when a line becomes a new listing. */
export type ExtraField = 'summary' | 'description' | 'specs' | 'year';
export type Target = Exclude<ColumnKey, 'reserved' | 'available' | 'margin' | 'marginPct' | 'link'> | ExtraField | 'ignore';

const EXTRA_ALIASES: Record<ExtraField, string[]> = {
  summary: ['summary', 'shortdescription', 'subtitle'],
  description: ['description', 'longdescription', 'details'],
  specs: ['specs', 'specifications', 'specification', 'techspecs'],
  year: ['year', 'yearmade', 'yearofmanufacture', 'manufactured'],
};

const IGNORED_ALIASES = new Set(['photos', 'photo', 'images', 'image', 'pictures', 'reserved', 'available', 'availableonsite', 'margin', 'marginpct', 'marginpercent', 'margineur', 'profit', 'listinglink', 'link', 'url', 'listingurl']);

export const TARGET_LABEL: Record<string, string> = {
  ...FIELD_LABEL,
  id: 'ID',
  summary: 'Summary (new listings)',
  description: 'Description (new listings)',
  specs: 'Specs (new listings, part number)',
  year: 'Year (new listings)',
  ignore: 'Ignore this column',
};

// ─── Reading files ──────────────────────────────────────────

function excelCell(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return excelCell((v as { result?: ExcelJS.CellValue }).result ?? null);
    if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join('');
    if ('text' in v) return String((v as { text: unknown }).text ?? '');
    if ('error' in v) return null;
  }
  return String(v);
}

async function readXlsx(bytes: Buffer): Promise<Sheet> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw new Error('This file could not be read as an Excel workbook (.xlsx). Save it as .xlsx or CSV and try again.');
  }
  const ws =
    wb.getWorksheet(DATA_SHEET) ??
    wb.worksheets.find((w) => w.state !== 'veryHidden' && w.state !== 'hidden' && w.name !== BASE_SHEET) ??
    wb.worksheets[0];
  if (!ws) throw new Error('The workbook has no sheets.');
  const width = ws.columnCount;
  const headers: string[] = [];
  const headerRow = ws.getRow(1);
  for (let c = 1; c <= width; c++) headers.push(cleanText(excelCell(headerRow.getCell(c).value)));
  const rows: Cell[][] = [];
  const lineNumbers: number[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const vals: Cell[] = [];
    for (let c = 1; c <= width; c++) vals.push(excelCell(row.getCell(c).value));
    if (vals.every((v) => v === null || (typeof v === 'string' && v.trim() === ''))) continue;
    rows.push(vals);
    lineNumbers.push(r);
    if (rows.length > MAX_IMPORT_ROWS) throw new Error(`The file has more than ${MAX_IMPORT_ROWS} lines. Split it into smaller files.`);
  }
  let base: Map<string, Record<string, Cell>> | null = null;
  let exportedAt: string | null = null;
  const b = wb.getWorksheet(BASE_SHEET);
  if (b && excelCell(b.getCell(1, 1).value) === EXPORT_MARKER) {
    base = new Map();
    exportedAt = String(excelCell(b.getCell(1, 2).value) ?? '') || null;
    for (let r = 2; r <= b.rowCount; r++) {
      const id = excelCell(b.getCell(r, 1).value);
      const json = excelCell(b.getCell(r, 2).value);
      if (typeof id !== 'string' || typeof json !== 'string') continue;
      try {
        base.set(id, JSON.parse(json) as Record<string, Cell>);
      } catch {
        /* a damaged base line only loses the conflict check for that item */
      }
    }
  }
  return { format: 'xlsx', headers, rows, lineNumbers, base, exportedAt };
}

/** RFC 4180 CSV with delimiter detection (comma, semicolon or tab). */
export function parseCsv(text: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLine = s.slice(0, s.search(/\r?\n/) >= 0 ? s.search(/\r?\n/) : s.length);
  const count = (d: string) => firstLine.split(d).length - 1;
  const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export async function readUpload(fileName: string, bytes: Buffer): Promise<Sheet> {
  if (bytes.length > MAX_IMPORT_BYTES) throw new Error('The file is larger than 5 MB.');
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip || /\.xlsx$/i.test(fileName)) return readXlsx(bytes);
  if (/\.xls$/i.test(fileName)) throw new Error('Old .xls files are not supported. In Excel choose File → Save as → Excel Workbook (.xlsx).');
  const text = bytes.toString('utf8');
  if (text.includes('\u0000')) throw new Error('This does not look like a CSV or .xlsx file.');
  const parsed = parseCsv(text).map((cells, i) => ({ cells, line: i + 1 }));
  const all = parsed.filter((r) => r.cells.some((c) => c.trim() !== ''));
  if (!all.length) throw new Error('The file is empty.');
  if (all.length - 1 > MAX_IMPORT_ROWS) throw new Error(`The file has more than ${MAX_IMPORT_ROWS} lines. Split it into smaller files.`);
  const body = all.slice(1);
  return { format: 'csv', headers: all[0].cells.map((h) => cleanText(h)), rows: body.map((r) => r.cells), lineNumbers: body.map((r) => r.line), base: null, exportedAt: null };
}

// ─── Column mapping ─────────────────────────────────────────

export function guessTarget(header: string): Target {
  const k = headerKey(header.replace(/\(.*?\)/g, ''));
  if (!k) return 'ignore';
  if (IGNORED_ALIASES.has(k)) return 'ignore';
  for (const c of COLUMNS) {
    if (!c.editable && c.key !== 'id') continue;
    if (c.aliases.includes(k)) return c.key as Target;
  }
  for (const [f, al] of Object.entries(EXTRA_ALIASES)) if (al.includes(k)) return f as ExtraField;
  return 'ignore';
}

export function autoMapping(headers: string[]): Target[] {
  const used = new Set<Target>();
  return headers.map((h) => {
    const t = guessTarget(h);
    if (t === 'ignore' || used.has(t)) return 'ignore';
    used.add(t);
    return t;
  });
}

// ─── Preview ────────────────────────────────────────────────

export type PreviewChange = { field: string; label: string; from: string; to: string; conflict?: { site: string; exported: string } };
export type PreviewStatus = 'update' | 'new' | 'unchanged' | 'conflict' | 'error' | 'skipped';
export type PreviewLine = {
  line: number; // spreadsheet line number (header = 1)
  status: PreviewStatus;
  title: string;
  match: { id: string; sku: string | null; by: string } | null;
  changes: PreviewChange[];
  errors: string[];
  notes: string[];
};
export type Preview = {
  id: string;
  fileName: string;
  format: 'xlsx' | 'csv';
  exportedAt: string | null;
  headers: string[];
  mapping: Target[];
  warnings: string[];
  lines: PreviewLine[];
  counts: Record<PreviewStatus, number>;
};

type PlanLine = {
  line: number;
  kind: 'update' | 'new';
  productId?: string;
  changes: CellChange[];
  conflicts: CellChange[];
  newItem?: Parameters<typeof createInventoryProduct>[0];
};

type Stored = { preview: Preview; plan: PlanLine[]; actorEmail: string | null; at: number };
// Process-wide so the preview and apply actions always see the same store.
const STORE: Map<string, Stored> = ((globalThis as { __inventoryImportStore?: Map<string, Stored> }).__inventoryImportStore ??= new Map());
const TTL_MS = 60 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [k, v] of STORE) if (now - v.at > TTL_MS) STORE.delete(k);
}

export function getStoredPreview(id: string, actorEmail: string | null): Stored | null {
  sweep();
  const s = STORE.get(id);
  return s && s.actorEmail === actorEmail ? s : null;
}

export function dropStoredPreview(id: string) {
  STORE.delete(id);
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

function parseSpecs(raw: Cell): Record<string, string> | null {
  const s = cleanText(raw);
  if (!s) return null;
  const out: Record<string, string> = {};
  for (const part of s.split(/;|\n/)) {
    const i = part.indexOf('=') >= 0 ? part.indexOf('=') : part.indexOf(':');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim().slice(0, 80);
    const v = part.slice(i + 1).trim().slice(0, 300);
    if (k && v) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

export async function buildPreview(
  fileName: string,
  sheet: Sheet,
  mapping: Target[],
  ctx: WriteContext,
): Promise<Preview> {
  const s: InventorySettings = ctx.settings;
  const warnings: string[] = [];
  const fieldCol = new Map<Target, number>();
  mapping.forEach((t, i) => {
    if (t === 'ignore') return;
    if (fieldCol.has(t)) warnings.push(`Two columns are set to "${TARGET_LABEL[t]}": only the first ("${sheet.headers[fieldCol.get(t)!]}") is used.`);
    else fieldCol.set(t, i);
  });
  if (!ctx.canCost && fieldCol.has('costCents')) {
    warnings.push('You do not have permission to change purchase costs: the cost column is ignored.');
    fieldCol.delete('costCents');
  }
  if (!ctx.canApprove && fieldCol.has('status')) {
    warnings.push('You do not have permission to publish or unpublish: the Site status column is ignored.');
    fieldCol.delete('status');
  }
  if (![...fieldCol.keys()].some((t) => ['id', 'sku', 'mpn', 'title'].includes(t))) {
    warnings.push('No column identifies the items (ID, SKU, Part number or Name), so every line would be a new item.');
  }
  const ignored = sheet.headers.filter((h, i) => h && mapping[i] === 'ignore');
  if (ignored.length) warnings.push(`Not imported: ${ignored.join(', ')}.`);
  if (sheet.base) warnings.push(`This file was exported on ${sheet.exportedAt?.slice(0, 16).replace('T', ' ') ?? 'an earlier date'} UTC. Cells you did not touch keep any change made on the site since (for example a sale).`);
  else warnings.push('This file was not exported from this inventory, so each line is compared with the current values only.');

  const all = await loadInventoryRows({ scope: 'all', canCost: true });
  const byId = new Map(all.map((r) => [r.id, r]));
  const bySku = new Map<string, InventoryRow>();
  const byMpn = new Map<string, InventoryRow[]>();
  const byTitle = new Map<string, InventoryRow[]>();
  for (const r of all) {
    if (r.sku) bySku.set(norm(r.sku), r);
    if (r.mpn) byMpn.set(norm(r.mpn), [...(byMpn.get(norm(r.mpn)) ?? []), r]);
    byTitle.set(norm(r.title), [...(byTitle.get(norm(r.title)) ?? []), r]);
  }
  const editableTargets = [...fieldCol.keys()].filter((t): t is EditableField => !!COLUMN_BY_KEY.get(t as ColumnKey)?.editable);

  const lines: PreviewLine[] = [];
  const plan: PlanLine[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < sheet.rows.length; i++) {
    const cells = sheet.rows[i];
    const line = sheet.lineNumbers[i] ?? i + 2;
    const get = (t: Target): Cell => (fieldCol.has(t) ? (cells[fieldCol.get(t)!] ?? null) : null);
    const has = (t: Target) => fieldCol.has(t);
    const txt = (t: Target) => cleanText(get(t));

    // Match the line to an item.
    let match: InventoryRow | null = null;
    let by = '';
    const errors: string[] = [];
    if (has('id') && txt('id')) {
      match = byId.get(txt('id')) ?? null;
      if (match) by = 'ID';
      else errors.push(`ID ${txt('id')} is not an item here (deleted, or a file from another system?).`);
    }
    if (!match && !errors.length && has('sku') && txt('sku')) {
      match = bySku.get(norm(txt('sku'))) ?? null;
      if (match) by = 'SKU';
    }
    if (!match && !errors.length && has('mpn') && txt('mpn')) {
      const list = byMpn.get(norm(txt('mpn'))) ?? [];
      if (list.length === 1) {
        match = list[0];
        by = 'part number';
      } else if (list.length > 1) errors.push(`Part number ${txt('mpn')} belongs to ${list.length} items; add the SKU or ID to say which.`);
    }
    if (!match && !errors.length && has('title') && txt('title')) {
      const list = byTitle.get(norm(txt('title'))) ?? [];
      if (list.length === 1) {
        match = list[0];
        by = 'name';
      } else if (list.length > 1) errors.push(`${list.length} items are called "${txt('title')}"; add the SKU or ID to say which.`);
    }
    if (match && seen.has(match.id)) {
      errors.push(`Same item as line ${seen.get(match.id)}; only the first line is used.`);
      match = null;
    }

    if (errors.length) {
      lines.push({ line, status: 'error', title: txt('title') || txt('sku') || txt('mpn') || `Line ${line}`, match: null, changes: [], errors, notes: [] });
      continue;
    }

    if (match) {
      seen.set(match.id, line);
      const base = sheet.base?.get(match.id) ?? null;
      const changes: CellChange[] = [];
      const conflicts: CellChange[] = [];
      const shown: PreviewChange[] = [];
      const notes: string[] = [];
      for (const f of editableTargets) {
        const raw = get(f);
        const col = COLUMN_BY_KEY.get(f)!;
        const blank = raw === null || (typeof raw === 'string' && raw.trim() === '');
        if (blank && (s.INVENTORY_IMPORT_BLANK === 'keep' || !col.clearable)) continue;
        const parsed = parseFieldValue(f, blank ? null : raw, s);
        if (!parsed.ok) {
          errors.push(parsed.message);
          continue;
        }
        const current = (match as unknown as Record<string, unknown>)[f] as Cell;
        if (sameValue(f, current, parsed.value)) continue;
        const baseValue = base && f in base ? base[f] : undefined;
        if (baseValue !== undefined && sameValue(f, parsed.value, baseValue)) continue; // untouched in the file
        const change: CellChange = { field: f, value: col.kind === 'money' && parsed.value !== null ? Number(parsed.value) / 100 : parsed.value, base: current };
        if (baseValue !== undefined && !sameValue(f, current, baseValue)) {
          conflicts.push(change);
          shown.push({ field: f, label: col.header, from: displayValue(f, current), to: displayValue(f, parsed.value), conflict: { site: displayValue(f, current), exported: displayValue(f, baseValue) } });
        } else {
          changes.push(change);
          shown.push({ field: f, label: col.header, from: displayValue(f, current), to: displayValue(f, parsed.value) });
        }
        if (f === 'onHand' && typeof parsed.value === 'number' && parsed.value < match.reserved) {
          errors.push(`On hand ${parsed.value} is lower than the ${match.reserved} unit${match.reserved === 1 ? '' : 's'} reserved in open orders.`);
        }
      }
      if (errors.length) {
        lines.push({ line, status: 'error', title: match.title, match: { id: match.id, sku: match.sku, by }, changes: shown, errors, notes });
        continue;
      }
      const status: PreviewStatus = conflicts.length ? 'conflict' : changes.length ? 'update' : 'unchanged';
      lines.push({ line, status, title: match.title, match: { id: match.id, sku: match.sku, by }, changes: shown, errors: [], notes });
      if (status !== 'unchanged') plan.push({ line, kind: 'update', productId: match.id, changes, conflicts });
      continue;
    }

    // No match: a new item (or skipped, per settings).
    const title = txt('title');
    if (s.INVENTORY_IMPORT_NEW_ROWS === 'skip') {
      lines.push({ line, status: 'skipped', title: title || `Line ${line}`, match: null, changes: [], errors: [], notes: ['No matching item; new lines are skipped (Inventory settings → Import).'] });
      continue;
    }
    if (!title) {
      lines.push({ line, status: 'error', title: `Line ${line}`, match: null, changes: [], errors: ['No matching item, and no Name to create one.'], notes: [] });
      continue;
    }
    const catName = txt('category') || '';
    let category = catName;
    if (!category && s.INVENTORY_IMPORT_DEFAULT_CATEGORY) {
      const c = await prisma.category.findFirst({ where: { slug: s.INVENTORY_IMPORT_DEFAULT_CATEGORY }, select: { name: true } });
      category = c?.name ?? '';
    }
    if (!category) errors.push('A new item needs a Category (or set a default category in Inventory settings → Import).');
    else if (!(await findCategory(prisma, category))) errors.push(`Category "${category}" does not exist. Add it under Categories, or correct the file.`);
    const specs = has('specs') ? parseSpecs(get('specs')) : null;
    const year = has('year') ? parseWholeNumber(get('year')) : null;
    const newItem = {
      title,
      category,
      condition: txt('condition') || undefined,
      mode: txt('mode') || undefined,
      brand: txt('brand') || undefined,
      status: (s.INVENTORY_IMPORT_NEW_ROWS === 'published' ? 'PUBLISHED' : 'DRAFT') as 'DRAFT' | 'PUBLISHED',
      summary: txt('summary') || null,
      description: has('description') ? cleanText(get('description')) || null : null,
      specs,
      yearMade: typeof year === 'number' && year >= 1900 && year <= 2100 ? year : null,
    };
    if (has('status') && txt('status')) {
      const st = parseFieldValue('status', get('status'), s);
      if (st.ok && (st.value === 'PUBLISHED' || st.value === 'DRAFT')) newItem.status = st.value;
    }
    for (const f of ['title', 'brand', 'condition', 'mode'] as const) {
      if (!txt(f)) continue;
      const p = parseFieldValue(f, get(f), s);
      if (!p.ok) errors.push(p.message);
    }
    const changes: CellChange[] = [];
    const shown: PreviewChange[] = [{ field: 'title', label: 'Name', from: '', to: title }];
    if (category) shown.push({ field: 'category', label: 'Category', from: '', to: category });
    for (const f of editableTargets) {
      if (['title', 'category', 'brand', 'condition', 'mode', 'status'].includes(f)) {
        if (f !== 'title' && f !== 'category' && txt(f)) shown.push({ field: f, label: FIELD_LABEL[f], from: '', to: displayValue(f, parseFieldValue(f, get(f), s).ok ? (parseFieldValue(f, get(f), s) as { value: Cell }).value : txt(f)) });
        continue;
      }
      const raw = get(f);
      if (raw === null || (typeof raw === 'string' && raw.trim() === '')) continue;
      const p = parseFieldValue(f, raw, s);
      if (!p.ok) {
        errors.push(p.message);
        continue;
      }
      changes.push({ field: f, value: COLUMN_BY_KEY.get(f)!.kind === 'money' && p.value !== null ? Number(p.value) / 100 : p.value });
      shown.push({ field: f, label: FIELD_LABEL[f], from: '', to: displayValue(f, p.value) });
    }
    const specMpn = partNumberFromSpecs(specs);
    if (specMpn && !changes.some((c) => c.field === 'mpn')) {
      changes.push({ field: 'mpn', value: specMpn });
      shown.push({ field: 'mpn', label: 'Part number', from: '', to: specMpn });
    }
    if (errors.length) {
      lines.push({ line, status: 'error', title, match: null, changes: shown, errors, notes: [] });
      continue;
    }
    lines.push({
      line,
      status: 'new',
      title,
      match: null,
      changes: shown,
      errors: [],
      notes: [newItem.status === 'PUBLISHED' ? 'Becomes a new published listing.' : 'Becomes a new draft listing (not on the site until you publish it).'],
    });
    plan.push({ line, kind: 'new', changes, conflicts: [], newItem });
  }

  const counts = { update: 0, new: 0, unchanged: 0, conflict: 0, error: 0, skipped: 0 } as Record<PreviewStatus, number>;
  for (const l of lines) counts[l.status]++;
  const id = `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const preview: Preview = { id, fileName, format: sheet.format, exportedAt: sheet.exportedAt, headers: sheet.headers, mapping, warnings, lines, counts };
  sweep();
  STORE.set(id, { preview, plan, actorEmail: ctx.actorEmail, at: Date.now() });
  return preview;
}

export type ApplyLineResult = { line: number; ok: boolean; title: string; message: string; productId?: string };

/**
 * Apply a stored preview. Lines whose item changed again after the preview are
 * refused (the save compares against what the preview showed), never overwritten.
 */
export async function applyPreview(
  stored: Stored,
  opts: { useFileForConflicts: number[]; skipLines: number[]; sellerId: string },
  ctx: WriteContext,
): Promise<ApplyLineResult[]> {
  const out: ApplyLineResult[] = [];
  const useFile = new Set(opts.useFileForConflicts);
  const skip = new Set(opts.skipLines);
  for (const p of stored.plan) {
    const title = stored.preview.lines.find((l) => l.line === p.line)?.title ?? `Line ${p.line}`;
    if (skip.has(p.line)) continue;
    if (p.kind === 'update') {
      const changes = [...p.changes, ...(useFile.has(p.line) ? p.conflicts : [])];
      if (!changes.length) {
        out.push({ line: p.line, ok: true, title, message: 'Kept the site values (conflict).', productId: p.productId });
        continue;
      }
      const r = await applyInventoryChanges(p.productId!, changes, ctx);
      out.push({
        line: p.line,
        ok: r.ok,
        title,
        productId: p.productId,
        message: r.ok ? `Saved: ${r.changed.map((f) => FIELD_LABEL[f] ?? f).join(', ') || 'no change'}.` : r.issues.map((i) => i.message).join(' '),
      });
      continue;
    }
    const created = await createInventoryProduct(p.newItem!, opts.sellerId, ctx);
    if (!created.ok) {
      out.push({ line: p.line, ok: false, title, message: created.message });
      continue;
    }
    const r = await applyInventoryChanges(created.id, p.changes.length ? p.changes : [{ field: 'onHand', value: 0 }], ctx);
    out.push({
      line: p.line,
      ok: true,
      title,
      productId: created.id,
      message: r.ok ? 'Created.' : `Created, but some values were not saved: ${r.issues.map((i) => i.message).join(' ')}`,
    });
  }
  return out;
}
