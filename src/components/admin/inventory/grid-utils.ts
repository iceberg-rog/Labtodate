/**
 * Pure helpers for the inventory sheet: clipboard (Excel's tab-separated
 * format), display text, sorting and the quick filters. No React, no server
 * imports, so they are unit-tested directly.
 */
import { COLUMN_BY_KEY, enumLabel, isLow, marginOf, type ColumnKey, type InventoryRow } from '@/lib/inventory/fields';
import { formatCents } from '@/lib/inventory/text';

/** Parse text copied from Excel / Google Sheets (TSV, quoted cells may hold tabs/newlines). */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let i = 0;
  let quoted = false;
  const s = text.replace(/\r\n?/g, '\n');
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === '\t') {
      row.push(cell);
      cell = '';
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
      continue;
    }
    cell += ch;
    i++;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Cells -> TSV that Excel pastes back into the same shape. */
export function toTsv(cells: string[][]): string {
  return cells
    .map((r) => r.map((c) => (/[\t\n"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join('\t'))
    .join('\n');
}

/** The text a cell shows. */
export function displayText(row: InventoryRow, key: ColumnKey): string {
  const col = COLUMN_BY_KEY.get(key);
  switch (key) {
    case 'margin': {
      const m = marginOf(row).cents;
      return m === null ? '' : formatCents(m);
    }
    case 'marginPct': {
      const m = marginOf(row).pct;
      return m === null ? '' : `${m.toFixed(1)}%`;
    }
    case 'link':
      return `/marketplace/${row.slug}`;
  }
  const v = (row as unknown as Record<string, unknown>)[key];
  if (v === null || v === undefined) return '';
  if (col?.kind === 'money') return formatCents(Number(v));
  if (col?.kind === 'enum') return enumLabel(key, String(v));
  return String(v);
}

/** Plain value for copying to Excel: numbers without thousands separators. */
export function copyText(row: InventoryRow, key: ColumnKey): string {
  const col = COLUMN_BY_KEY.get(key);
  if (key === 'link') return `/marketplace/${row.slug}`;
  if (key === 'margin') {
    const m = marginOf(row).cents;
    return m === null ? '' : (m / 100).toFixed(2);
  }
  if (key === 'marginPct') {
    const m = marginOf(row).pct;
    return m === null ? '' : String(m);
  }
  const v = (row as unknown as Record<string, unknown>)[key];
  if (v === null || v === undefined) return '';
  if (col?.kind === 'money') return (Number(v) / 100).toFixed(2);
  if (col?.kind === 'enum') return enumLabel(key, String(v));
  return String(v);
}

/** What the editor starts with for a cell (money as 1234.50, enums as their label). */
export function editText(row: InventoryRow, key: ColumnKey): string {
  return copyText(row, key);
}

/** A row value in the form the server expects back as `base` / an undo value. */
export function wireValue(row: InventoryRow, key: ColumnKey): string | number | null {
  const v = (row as unknown as Record<string, unknown>)[key];
  if (v === undefined) return null;
  return v as string | number | null;
}

/** Undo sends the old value: money goes back as a decimal amount. */
export function undoValue(key: ColumnKey, base: string | number | null): string | number | null {
  const col = COLUMN_BY_KEY.get(key);
  if (base === null) return null;
  if (col?.kind === 'money') return (Number(base) / 100).toFixed(2);
  return base;
}

export type QuickFilter = 'all' | 'low' | 'out' | 'reserved' | 'nocost' | 'lowmargin' | 'offsite' | 'nosku';

export function matchesQuickFilter(
  row: InventoryRow,
  f: QuickFilter,
  opts: { lowDefault: number; minMarginPct: number; canCost: boolean },
): boolean {
  switch (f) {
    case 'all':
      return true;
    case 'low':
      return row.status !== 'ARCHIVED' && isLow(row, opts.lowDefault);
    case 'out':
      return row.available <= 0;
    case 'reserved':
      return row.reserved > 0;
    case 'nocost':
      return opts.canCost && row.costCents === null;
    case 'lowmargin': {
      if (!opts.canCost) return false;
      const m = marginOf(row);
      return m.cents !== null && (m.cents < 0 || (m.pct !== null && m.pct < opts.minMarginPct));
    }
    case 'offsite':
      return row.status !== 'PUBLISHED';
    case 'nosku':
      return !row.sku;
  }
}

export function matchesSearch(row: InventoryRow, q: string): boolean {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = [row.sku, row.mpn, row.title, row.brand, row.category, row.supplier, row.location, row.notes, row.slug]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export type SortState = { key: ColumnKey; dir: 'asc' | 'desc' } | null;

function sortValue(row: InventoryRow, key: ColumnKey): string | number | null {
  if (key === 'margin') return marginOf(row).cents;
  if (key === 'marginPct') return marginOf(row).pct;
  if (key === 'link') return row.slug;
  const v = (row as unknown as Record<string, unknown>)[key];
  if (v === null || v === undefined || v === '') return null;
  const col = COLUMN_BY_KEY.get(key);
  if (col?.kind === 'enum') return enumLabel(key, String(v)).toLowerCase();
  return typeof v === 'number' ? v : String(v).toLowerCase();
}

/** Sort ids by a column; empty values always last, ties keep the previous order. */
export function sortIds(ids: string[], byId: Map<string, InventoryRow>, sort: SortState): string[] {
  if (!sort) return ids;
  const pos = new Map(ids.map((id, i) => [id, i]));
  return [...ids].sort((a, b) => {
    const va = sortValue(byId.get(a)!, sort.key);
    const vb = sortValue(byId.get(b)!, sort.key);
    if (va === null && vb === null) return pos.get(a)! - pos.get(b)!;
    if (va === null) return 1;
    if (vb === null) return -1;
    let c: number;
    if (typeof va === 'number' && typeof vb === 'number') c = va - vb;
    else c = String(va).localeCompare(String(vb), 'en', { numeric: true });
    if (c === 0) return pos.get(a)! - pos.get(b)!;
    return sort.dir === 'asc' ? c : -c;
  });
}
