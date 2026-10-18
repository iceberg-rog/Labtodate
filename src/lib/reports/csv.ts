/**
 * CSV for accounting exports (orders, sold items, documents): UTF-8 with a
 * BOM so Excel opens it with the right characters, amounts as plain
 * numbers with two decimals, dates as YYYY-MM-DD / ISO.
 */

export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  // Spreadsheet formula injection: buyer names, product titles etc. are user
  // controlled, and Excel / LibreOffice execute a cell starting with = + - @
  // (or a leading tab / CR). Prefix those with ' so they open as text. Plain
  // numbers (amounts) are left alone so they stay numeric.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Cents as a plain decimal amount ("1234.50", "-12.10"); '' when unknown. */
export function csvMoney(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? '' : (cents / 100).toFixed(2);
}

/** A VAT rate in basis points as a percentage ("21", "9", "0", "5.5"). */
export function csvRate(bp: number | null | undefined): string {
  return bp === null || bp === undefined ? '' : String(Number((bp / 100).toFixed(2)));
}

const BOM = String.fromCharCode(0xfeff);

export function csvDocument(header: readonly string[], rows: ReadonlyArray<readonly unknown[]>): string {
  return BOM + [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');
}

/** The brand as a file-name prefix ("Labtodate" → "labtodate"). */
export function fileSlug(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'export';
}

export function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename.replace(/[^\w.-]+/g, '-')}"`,
      'Cache-Control': 'no-store',
    },
  });
}
