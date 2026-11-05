import ExcelJS from 'exceljs';
import { COLUMNS, enumLabel, enumOptions, marginOf, type ColumnDef, type InventoryRow } from './fields';

/**
 * Excel / CSV export of the inventory.
 *
 * The .xlsx carries a very-hidden sheet "_base" with each row's values at the
 * moment of export. On import that lets us tell "you changed this cell" from
 * "the site changed it since" (e.g. a sale), so an old file never undoes a sale.
 */

export const BASE_SHEET = '_base';
export const LISTS_SHEET = '_lists';
export const DATA_SHEET = 'Inventory';
export const EXPORT_MARKER = 'labtodate-inventory-export';

/** Export column order: ID goes last so the sheet reads naturally from the left. */
export function exportColumns(canCost: boolean): ColumnDef[] {
  const cols = COLUMNS.filter((c) => !c.cost || canCost);
  return [...cols.filter((c) => c.key !== 'id'), cols.find((c) => c.key === 'id')!];
}

/** The base values stored per row: the editable fields, in their stored form. */
export function baseValues(row: InventoryRow, canCost: boolean): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const c of COLUMNS) {
    if (!c.editable || (c.cost && !canCost)) continue;
    out[c.key] = (row as unknown as Record<string, string | number | null>)[c.key] ?? null;
  }
  return out;
}

function colLetter(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

export async function buildXlsx(
  rows: InventoryRow[],
  opts: { canCost: boolean; suppliers: string[]; categories: string[]; siteUrl: string; exportedBy: string | null },
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Labtodate';
  wb.created = new Date();
  const cols = exportColumns(opts.canCost);
  const idx = new Map(cols.map((c, i) => [c.key, i + 1]));
  const L = (k: string) => colLetter(idx.get(k as never) ?? 0);

  const ws = wb.addWorksheet(DATA_SHEET, { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });
  ws.columns = cols.map((c) => ({
    header: c.key === 'id' ? 'ID (do not edit)' : c.header,
    key: c.key,
    width: c.xlsxWidth,
  }));

  // Header styling: dark band; private (cost) columns amber; calculated columns grey.
  const header = ws.getRow(1);
  header.height = 22;
  cols.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.font = { bold: true, color: { argb: c.cost ? 'FF3D2A00' : c.editable ? 'FFFFFFFF' : 'FF333333' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.cost ? 'FFF5C451' : c.editable ? 'FF0F4F40' : 'FFD9D9D9' } };
    cell.alignment = { vertical: 'middle' };
    const notes = [c.hint, c.cost ? 'Private: never shown on the site.' : null].filter(Boolean).join(' ');
    if (notes) cell.note = notes;
  });

  rows.forEach((row, i) => {
    const r = i + 2;
    const values: Record<string, unknown> = {};
    for (const c of cols) {
      const v = (row as unknown as Record<string, unknown>)[c.key];
      switch (c.key) {
        case 'available':
          values[c.key] = { formula: `${L('onHand')}${r}-${L('reserved')}${r}`, result: row.available };
          break;
        case 'margin': {
          const m = marginOf(row).cents;
          values[c.key] = {
            formula: `IF(AND(ISNUMBER(${L('priceCents')}${r}),ISNUMBER(${L('costCents')}${r})),${L('priceCents')}${r}-${L('costCents')}${r},"")`,
            result: m === null ? '' : m / 100,
          };
          break;
        }
        case 'marginPct': {
          const m = marginOf(row).pct;
          values[c.key] = {
            formula: `IF(AND(ISNUMBER(${L('priceCents')}${r}),ISNUMBER(${L('costCents')}${r}),${L('priceCents')}${r}>0),(${L('priceCents')}${r}-${L('costCents')}${r})/${L('priceCents')}${r},"")`,
            result: m === null ? '' : m / 100,
          };
          break;
        }
        case 'link':
          values[c.key] = { text: `${opts.siteUrl}/marketplace/${row.slug}`, hyperlink: `${opts.siteUrl}/marketplace/${row.slug}` };
          break;
        default:
          if (v === null || v === undefined) values[c.key] = null;
          else if (c.kind === 'money') values[c.key] = Number(v) / 100;
          else if (c.kind === 'enum') values[c.key] = enumLabel(c.key, String(v));
          else values[c.key] = v;
      }
    }
    const xr = ws.addRow(values);
    cols.forEach((c, ci) => {
      const cell = xr.getCell(ci + 1);
      if (c.kind === 'money' || c.key === 'margin') cell.numFmt = '#,##0.00';
      if (c.key === 'marginPct') cell.numFmt = '0.0%';
      if (!c.editable) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
        cell.font = { color: { argb: c.key === 'link' ? 'FF0F4F40' : 'FF555555' }, underline: c.key === 'link' ? true : undefined };
      }
    });
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };

  // Drop-down lists (rows left free below the data so new lines get them too).
  const lists = wb.addWorksheet(LISTS_SHEET, { state: 'veryHidden' });
  const supplierList = opts.suppliers.length ? opts.suppliers : [''];
  supplierList.forEach((s, i) => (lists.getCell(i + 1, 1).value = s));
  opts.categories.forEach((s, i) => (lists.getCell(i + 1, 2).value = s));
  const lastRow = rows.length + 500;
  // Added to the sheet's validation model per address (not through getCell), so no
  // empty rows are created; the writer merges them into one range per column.
  const validations = (ws as unknown as { dataValidations: { add(address: string, v: ExcelJS.DataValidation): void } }).dataValidations;
  const listRule = (key: string, formulae: string[], strict: boolean) => {
    const col = idx.get(key as never);
    if (!col) return;
    for (let r = 2; r <= lastRow; r++) {
      validations.add(`${colLetter(col)}${r}`, {
        type: 'list',
        allowBlank: true,
        formulae,
        showErrorMessage: strict,
        errorStyle: 'stop',
        errorTitle: 'Choose from the list',
        error: 'Pick one of the values in the drop-down.',
      });
    }
  };
  const inline = (k: 'condition' | 'mode' | 'status') => [`"${enumOptions(k).map((o) => o.label).join(',')}"`];
  listRule('condition', inline('condition'), true);
  listRule('mode', inline('mode'), true);
  listRule('status', inline('status'), true);
  listRule('supplier', [`${LISTS_SHEET}!$A$1:$A$${supplierList.length}`], false); // new names allowed
  if (opts.categories.length) listRule('category', [`${LISTS_SHEET}!$B$1:$B$${opts.categories.length}`], true);

  // Values at export time, for the three-way comparison on import.
  const base = wb.addWorksheet(BASE_SHEET, { state: 'veryHidden' });
  base.getCell(1, 1).value = EXPORT_MARKER;
  base.getCell(1, 2).value = new Date().toISOString();
  base.getCell(1, 3).value = opts.exportedBy ?? '';
  base.getCell(1, 4).value = opts.canCost ? 'cost' : 'nocost';
  rows.forEach((row, i) => {
    base.getCell(i + 2, 1).value = row.id;
    base.getCell(i + 2, 2).value = JSON.stringify(baseValues(row, opts.canCost));
  });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n;]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV (UTF-8 with BOM so Excel opens it with the right characters). */
export function buildCsv(rows: InventoryRow[], opts: { canCost: boolean; siteUrl: string }): string {
  const cols = exportColumns(opts.canCost);
  const lines = [cols.map((c) => csvCell(c.key === 'id' ? 'ID (do not edit)' : c.header)).join(',')];
  for (const row of rows) {
    lines.push(
      cols
        .map((c) => {
          const v = (row as unknown as Record<string, unknown>)[c.key];
          switch (c.key) {
            case 'margin': {
              const m = marginOf(row).cents;
              return csvCell(m === null ? '' : (m / 100).toFixed(2));
            }
            case 'marginPct': {
              const m = marginOf(row).pct;
              return csvCell(m === null ? '' : `${m}%`);
            }
            case 'link':
              return csvCell(`${opts.siteUrl}/marketplace/${row.slug}`);
          }
          if (v === null || v === undefined) return '';
          if (c.kind === 'money') return csvCell((Number(v) / 100).toFixed(2));
          if (c.kind === 'enum') return csvCell(enumLabel(c.key, String(v)));
          return csvCell(v);
        })
        .join(','),
    );
  }
  return String.fromCharCode(0xfeff) + lines.join('\r\n') + '\r\n';
}
