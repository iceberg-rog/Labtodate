'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Columns3,
  Download,
  EyeOff,
  History,
  Keyboard,
  Loader2,
  Minus,
  Plus,
  Search,
  Settings2,
  SquareArrowOutUpRight,
  Truck,
  Upload,
  X,
} from 'lucide-react';
import {
  COLUMNS,
  enumOptions,
  isLow,
  marginOf,
  type ColumnDef,
  type ColumnKey,
  type EditableField,
  type InventoryRow,
} from '@/lib/inventory/fields';
import { formatCents } from '@/lib/inventory/text';
import { bulkInventory, saveInventoryRows, type BulkOp, type RowResult } from '@/app/admin/inventory/actions';
import {
  copyText,
  displayText,
  editText,
  matchesQuickFilter,
  matchesSearch,
  parseTsv,
  sortIds,
  toTsv,
  undoValue,
  wireValue,
  type QuickFilter,
  type SortState,
} from './grid-utils';
import { HistoryDrawer, NewItemDialog, ReservedPopover, Toasts, type Toast } from './InventoryDialogs';

export type GridPerms = { edit: boolean; cost: boolean; approve: boolean; import: boolean; settings: boolean };
export type GridRules = { lowDefault: number; minMarginPct: number; newMode: string; newCondition: string };

type Props = {
  initialRows: InventoryRow[];
  scope: 'own' | 'all';
  suppliers: string[];
  categories: { name: string; slug: string }[];
  brands: string[];
  locations: string[];
  perms: GridPerms;
  rules: GridRules;
  focusId?: string | null;
  initialFilter?: QuickFilter;
  initialQuery?: string;
};

type Pos = { r: number; c: number };
type Editing = { r: number; c: number; text: string; fresh: boolean };
type CellState = { s: 'saving' | 'saved' | 'error' | 'conflict'; msg?: string };
type UndoEntry = { id: string; field: EditableField; before: string | number | null; after: string | number | null };

const DEFAULT_HIDDEN: ColumnKey[] = ['category', 'lowStockAt'];
const HIDDEN_KEY = 'inventory.hiddenColumns.v1';
const CHECK_W = 36;
const ACTIONS_W = 40;

const QUICK_FILTERS: { key: QuickFilter; label: string; cost?: boolean }[] = [
  { key: 'all', label: 'All' },
  { key: 'low', label: 'Low stock' },
  { key: 'out', label: 'Nothing available' },
  { key: 'reserved', label: 'Reserved' },
  { key: 'nocost', label: 'No purchase cost', cost: true },
  { key: 'lowmargin', label: 'Margin too low', cost: true },
  { key: 'offsite', label: 'Not on site' },
  { key: 'nosku', label: 'No SKU' },
];

const ck = (id: string, field: string) => `${id}|${field}`;

export function InventoryGrid(props: Props) {
  const { perms, rules } = props;
  const [rows, setRows] = useState<InventoryRow[]>(props.initialRows);
  const rowsRef = useRef(rows);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  const [suppliers, setSuppliers] = useState(props.suppliers);
  const [brands, setBrands] = useState(props.brands);
  const [locations, setLocations] = useState(props.locations);

  // ── Columns ──
  const [hidden, setHidden] = useState<Set<ColumnKey>>(new Set(DEFAULT_HIDDEN));
  useEffect(() => {
    try {
      const raw = localStorage.getItem(HIDDEN_KEY);
      if (raw) setHidden(new Set(JSON.parse(raw) as ColumnKey[]));
    } catch {
      /* private mode: defaults */
    }
  }, []);
  const toggleColumn = (k: ColumnKey) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      try {
        localStorage.setItem(HIDDEN_KEY, JSON.stringify([...n]));
      } catch {
        /* ignore */
      }
      return n;
    });
  const allCols = useMemo(() => COLUMNS.filter((c) => c.key !== 'id' && (!c.cost || perms.cost)), [perms.cost]);
  const cols = useMemo(() => allCols.filter((c) => !hidden.has(c.key)), [allCols, hidden]);
  const colsRef = useRef(cols);

  // ── Filtering / sorting (recomputed on demand, not on every edit, like a spreadsheet) ──
  const [query, setQuery] = useState(props.initialQuery ?? '');
  const [quick, setQuick] = useState<QuickFilter>(props.initialFilter ?? 'all');
  const [sort, setSort] = useState<SortState>(null);
  // The rows the current filter/sort was computed from. Like a spreadsheet, a
  // row does not jump away while it is being edited: the view is recomputed
  // only when the filter, search or sort changes (or "Refresh filter").
  const [snapshot, setSnapshot] = useState<InventoryRow[]>(props.initialRows);
  const refilter = () => setSnapshot(rows);
  const filterOpts = useMemo(
    () => ({ lowDefault: rules.lowDefault, minMarginPct: rules.minMarginPct, canCost: perms.cost }),
    [rules.lowDefault, rules.minMarginPct, perms.cost],
  );
  const order = useMemo(() => {
    const map = new Map(snapshot.map((r) => [r.id, r]));
    const ids = snapshot.filter((r) => matchesQuickFilter(r, quick, filterOpts) && matchesSearch(r, query)).map((r) => r.id);
    return sortIds(ids, map, sort);
  }, [snapshot, quick, query, sort, filterOpts]);
  const orderRef = useRef(order);
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const f of QUICK_FILTERS) out[f.key] = rows.filter((r) => matchesQuickFilter(r, f.key, filterOpts)).length;
    return out;
  }, [rows, filterOpts]);
  const stale = useMemo(
    () => order.some((id) => { const r = byId.get(id); return !r || !matchesQuickFilter(r, quick, filterOpts) || !matchesSearch(r, query); }),
    [order, byId, quick, query, filterOpts],
  );

  // ── Cursor, range, editing ──
  const [active, setActive] = useState<Pos>({ r: 0, c: 0 });
  const [anchor, setAnchor] = useState<Pos | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const activeRef = useRef(active);
  const anchorRef = useRef(anchor);
  const editingRef = useRef(editing);
  // Event handlers read the latest values through refs, synced after each render.
  useLayoutEffect(() => {
    rowsRef.current = rows;
    colsRef.current = cols;
    orderRef.current = order;
    activeRef.current = active;
    anchorRef.current = anchor;
    editingRef.current = editing;
  });
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const range = useMemo(() => {
    const a = anchor ?? active;
    return { r0: Math.min(a.r, active.r), r1: Math.max(a.r, active.r), c0: Math.min(a.c, active.c), c1: Math.max(a.c, active.c) };
  }, [anchor, active]);

  // ── Per-cell save state ──
  // Per-cell save state and the text shown while a save is in flight, keyed
  // row -> field so an update only re-renders the rows it touches.
  const [cellStates, setCellStates] = useState<Record<string, Record<string, CellState>>>({});
  const [pendingText, setPendingText] = useState<Record<string, Record<string, string>>>({});
  const setCell = useCallback((id: string, field: string, st: CellState | null) => {
    setCellStates((all) => {
      const row = { ...(all[id] ?? {}) };
      if (st) row[field] = st;
      else delete row[field];
      return { ...all, [id]: row };
    });
  }, []);
  const clearCellIf = useCallback((id: string, field: string, state: CellState['s']) => {
    setCellStates((all) => {
      if (all[id]?.[field]?.s !== state) return all;
      const row = { ...all[id] };
      delete row[field];
      return { ...all, [id]: row };
    });
  }, []);
  const setPending = useCallback((id: string, field: string, text: string | null) => {
    setPendingText((all) => {
      const row = { ...(all[id] ?? {}) };
      if (text === null) delete row[field];
      else row[field] = text;
      return { ...all, [id]: row };
    });
  }, []);

  // ── Row selection (checkboxes) ──
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleRow = useCallback((id: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  // ── Toasts ──
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((x) => [...x.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), t.kind === 'error' ? 9000 : 4500);
  }, []);

  // ── Dialogs ──
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [reservedFor, setReservedFor] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [newItemOpen, setNewItemOpen] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [showCols, setShowCols] = useState(false);

  const undoStack = useRef<UndoEntry[]>([]);

  const replaceRows = useCallback((updated: InventoryRow[]) => {
    if (!updated.length) return;
    const m = new Map(updated.map((r) => [r.id, r]));
    setRows((cur) => cur.map((r) => m.get(r.id) ?? r));
    setSuppliers((s) => mergeNames(s, updated.map((r) => r.supplier)));
    setBrands((s) => mergeNames(s, updated.map((r) => r.brand)));
    setLocations((s) => mergeNames(s, updated.map((r) => r.location)));
  }, []);

  /** Save edits; shows per-cell state, toasts, records undo. */
  const save = useCallback(
    async (edits: { id: string; changes: { field: EditableField; value: string | number | null; base?: string | number | null }[] }[], opts: { isUndo?: boolean } = {}) => {
      if (!edits.length) return;
      for (const e of edits) for (const ch of e.changes) setCell(e.id, ch.field, { s: 'saving' });
      let results: RowResult[];
      try {
        results = (await saveInventoryRows(edits)).results;
      } catch {
        for (const e of edits)
          for (const ch of e.changes) {
            setPending(e.id, ch.field, null);
            setCell(e.id, ch.field, { s: 'error', msg: 'Could not reach the server. Nothing was saved.' });
          }
        toast({ kind: 'error', text: 'Could not reach the server. Nothing was saved.' });
        return;
      }
      const updated: InventoryRow[] = [];
      const saved: [string, string][] = [];
      for (const res of results) {
        const edit = edits.find((e) => e.id === res.id)!;
        if (res.row) updated.push(res.row);
        for (const ch of edit.changes) setPending(res.id, ch.field, null);
        if (res.ok) {
          for (const ch of edit.changes) {
            setCell(res.id, ch.field, { s: 'saved' });
            saved.push([res.id, ch.field]);
            if (!opts.isUndo && res.row && ch.base !== undefined && res.changed.includes(ch.field)) {
              undoStack.current.push({ id: res.id, field: ch.field, before: ch.base, after: wireValue(res.row, ch.field) });
              if (undoStack.current.length > 200) undoStack.current.shift();
            }
          }
          for (const n of res.notes) toast({ kind: 'info', text: n });
        } else {
          for (const ch of edit.changes) {
            const issue = res.issues.find((i) => i.field === ch.field) ?? res.issues.find((i) => i.field === '*') ?? res.issues[0];
            setCell(res.id, ch.field, { s: issue?.kind === 'conflict' ? 'conflict' : 'error', msg: issue?.message });
          }
          const title = res.row?.title ?? 'Item';
          toast({ kind: res.issues.some((i) => i.kind === 'conflict') ? 'warn' : 'error', text: `${title}: ${res.issues.map((i) => i.message).join(' ')}` });
        }
      }
      replaceRows(updated);
      setTimeout(() => {
        for (const [id, field] of saved) clearCellIf(id, field, 'saved');
      }, 1600);
    },
    [clearCellIf, replaceRows, setCell, setPending, toast],
  );

  const undo = useCallback(() => {
    const u = undoStack.current.pop();
    if (!u) {
      toast({ kind: 'info', text: 'Nothing to undo.' });
      return;
    }
    const row = rowsRef.current.find((r) => r.id === u.id);
    void save([{ id: u.id, changes: [{ field: u.field, value: undoValue(u.field, u.before), base: u.after }] }], { isUndo: true });
    toast({ kind: 'info', text: `Undone: ${COLUMNS.find((c) => c.key === u.field)?.header} of ${row?.title ?? 'item'}.` });
  }, [save, toast]);

  // ── Navigation ──
  const scrollToCell = useCallback((p: Pos) => {
    const id = orderRef.current[p.r];
    const col = colsRef.current[p.c];
    if (!id || !col) return;
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-cell="${id}|${col.key}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, []);
  const moveTo = useCallback(
    (p: Pos, extend = false) => {
      const maxR = orderRef.current.length - 1;
      const maxC = colsRef.current.length - 1;
      const n = { r: Math.max(0, Math.min(maxR, p.r)), c: Math.max(0, Math.min(maxC, p.c)) };
      if (extend) {
        if (!anchorRef.current) setAnchor(activeRef.current);
      } else setAnchor(null);
      setActive(n);
      requestAnimationFrame(() => scrollToCell(n));
    },
    [scrollToCell],
  );

  const focusGrid = () => gridRef.current?.focus({ preventScroll: true });

  const startEdit = useCallback(
    (p: Pos, initial?: string) => {
      if (!perms.edit) return;
      const id = orderRef.current[p.r];
      const col = colsRef.current[p.c];
      const row = id ? rowsRef.current.find((r) => r.id === id) : undefined;
      if (!row || !col || !col.editable) {
        if (col?.key === 'reserved' && row) {
          const el = gridRef.current?.querySelector<HTMLElement>(`[data-cell="${row.id}|reserved"]`);
          if (el) setReservedFor({ id: row.id, rect: el.getBoundingClientRect() });
        }
        return;
      }
      if (col.cost && !perms.cost) return;
      if (col.key === 'status' && !perms.approve) {
        toast({ kind: 'error', text: 'You do not have permission to publish or unpublish items.' });
        return;
      }
      setAnchor(null);
      setEditing({ r: p.r, c: p.c, text: initial ?? editText(row, col.key), fresh: initial !== undefined });
    },
    [perms.approve, perms.cost, perms.edit, toast],
  );

  const commitEdit = useCallback(
    (text: string, move: 'down' | 'up' | 'right' | 'left' | 'none') => {
      const e = editingRef.current;
      if (!e) return;
      const id = orderRef.current[e.r];
      const col = colsRef.current[e.c];
      const row = rowsRef.current.find((r) => r.id === id);
      setEditing(null);
      if (row && col && col.editable) {
        const before = wireValue(row, col.key);
        const unchanged = editText(row, col.key) === text.trim();
        const confirmSpecMpn = col.key === 'mpn' && row.mpnFromSpecs && text.trim() !== '';
        if (!unchanged || confirmSpecMpn) {
          setPending(row.id, col.key, text);
          void save([{ id: row.id, changes: [{ field: col.key as EditableField, value: text, base: before }] }]);
        }
      }
      const d = { down: [1, 0], up: [-1, 0], right: [0, 1], left: [0, -1], none: [0, 0] }[move];
      moveTo({ r: e.r + d[0], c: e.c + d[1] });
      focusGrid();
    },
    [moveTo, save, setPending],
  );

  const cancelEdit = useCallback(() => {
    setEditing(null);
    focusGrid();
  }, []);

  /** Clear (Delete key) every editable, clearable cell in the range. */
  const clearRange = useCallback(() => {
    if (!perms.edit) return;
    const edits: { id: string; changes: { field: EditableField; value: null; base: string | number | null }[] }[] = [];
    let skipped = 0;
    for (let r = range.r0; r <= range.r1; r++) {
      const row = rowsRef.current.find((x) => x.id === orderRef.current[r]);
      if (!row) continue;
      const changes: { field: EditableField; value: null; base: string | number | null }[] = [];
      for (let c = range.c0; c <= range.c1; c++) {
        const col = colsRef.current[c];
        if (!col?.editable || !col.clearable || (col.cost && !perms.cost)) {
          if (col?.editable) skipped++;
          continue;
        }
        if (wireValue(row, col.key) === null) continue;
        changes.push({ field: col.key as EditableField, value: null, base: wireValue(row, col.key) });
      }
      if (changes.length) edits.push({ id: row.id, changes });
    }
    if (skipped) toast({ kind: 'info', text: `${skipped} cell${skipped === 1 ? '' : 's'} can not be empty and ${skipped === 1 ? 'was' : 'were'} left as is.` });
    void save(edits);
  }, [perms.cost, perms.edit, range, save, toast]);

  // ── Clipboard ──
  useEffect(() => {
    const inGrid = () => !!gridRef.current && gridRef.current.contains(document.activeElement) && !editingRef.current;
    const onCopy = (e: ClipboardEvent) => {
      if (!inGrid()) return;
      const cells: string[][] = [];
      for (let r = range.r0; r <= range.r1; r++) {
        const row = rowsRef.current.find((x) => x.id === orderRef.current[r]);
        if (!row) continue;
        const line: string[] = [];
        for (let c = range.c0; c <= range.c1; c++) line.push(copyText(row, colsRef.current[c].key));
        cells.push(line);
      }
      e.clipboardData?.setData('text/plain', toTsv(cells));
      e.preventDefault();
      const n = (range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1);
      toast({ kind: 'info', text: `Copied ${n} cell${n === 1 ? '' : 's'}.` });
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!inGrid() || !perms.edit) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!text) return;
      e.preventDefault();
      let data = parseTsv(text);
      // One value pasted onto a selected range fills the range (as Excel does).
      const single = data.length === 1 && data[0].length === 1;
      const height = single ? range.r1 - range.r0 + 1 : data.length;
      const width = single ? range.c1 - range.c0 + 1 : Math.max(...data.map((d) => d.length));
      if (single) data = Array.from({ length: height }, () => Array.from({ length: width }, () => data[0][0]));
      const edits = new Map<string, { field: EditableField; value: string; base: string | number | null }[]>();
      let skipped = 0;
      for (let i = 0; i < height; i++) {
        const id = orderRef.current[range.r0 + i];
        const row = rowsRef.current.find((x) => x.id === id);
        if (!row) break;
        for (let j = 0; j < width; j++) {
          const col = colsRef.current[range.c0 + j];
          const v = data[i]?.[j];
          if (!col || v === undefined) continue;
          if (!col.editable || (col.cost && !perms.cost) || (col.key === 'status' && !perms.approve)) {
            skipped++;
            continue;
          }
          if (editText(row, col.key) === v.trim()) continue;
          const list = edits.get(row.id) ?? [];
          list.push({ field: col.key as EditableField, value: v, base: wireValue(row, col.key) });
          edits.set(row.id, list);
          setPending(row.id, col.key, v);
        }
      }
      if (skipped) toast({ kind: 'info', text: `${skipped} pasted cell${skipped === 1 ? '' : 's'} went to read-only columns and ${skipped === 1 ? 'was' : 'were'} skipped.` });
      void save([...edits].map(([id, changes]) => ({ id, changes })));
      const last = { r: Math.min(orderRef.current.length - 1, range.r0 + height - 1), c: Math.min(colsRef.current.length - 1, range.c0 + width - 1) };
      setAnchor({ r: range.r0, c: range.c0 });
      setActive(last);
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('paste', onPaste);
    };
  }, [perms.approve, perms.cost, perms.edit, range, save, setPending, toast]);

  // ── Keyboard (when not editing) ──
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editingRef.current) return;
    const mod = e.ctrlKey || e.metaKey;
    const a = activeRef.current;
    const pageRows = 12;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveTo({ r: mod ? orderRef.current.length - 1 : a.r + 1, c: a.c }, e.shiftKey);
        return;
      case 'ArrowUp':
        e.preventDefault();
        moveTo({ r: mod ? 0 : a.r - 1, c: a.c }, e.shiftKey);
        return;
      case 'ArrowRight':
        e.preventDefault();
        moveTo({ r: a.r, c: mod ? colsRef.current.length - 1 : a.c + 1 }, e.shiftKey);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        moveTo({ r: a.r, c: mod ? 0 : a.c - 1 }, e.shiftKey);
        return;
      case 'Tab':
        e.preventDefault();
        moveTo({ r: a.r, c: a.c + (e.shiftKey ? -1 : 1) });
        return;
      case 'Enter':
        e.preventDefault();
        moveTo({ r: a.r + (e.shiftKey ? -1 : 1), c: a.c });
        return;
      case 'PageDown':
        e.preventDefault();
        moveTo({ r: a.r + pageRows, c: a.c }, e.shiftKey);
        return;
      case 'PageUp':
        e.preventDefault();
        moveTo({ r: a.r - pageRows, c: a.c }, e.shiftKey);
        return;
      case 'Home':
        e.preventDefault();
        moveTo({ r: mod ? 0 : a.r, c: 0 }, e.shiftKey);
        return;
      case 'End':
        e.preventDefault();
        moveTo({ r: mod ? orderRef.current.length - 1 : a.r, c: colsRef.current.length - 1 }, e.shiftKey);
        return;
      case 'F2':
        e.preventDefault();
        startEdit(a);
        return;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        clearRange();
        return;
      case 'Escape':
        setAnchor(null);
        return;
      case ' ':
        if (e.shiftKey) {
          e.preventDefault();
          const id = orderRef.current[a.r];
          if (id) toggleRow(id);
        }
        return;
    }
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      undo();
      return;
    }
    if (mod && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      setAnchor({ r: 0, c: 0 });
      setActive({ r: orderRef.current.length - 1, c: colsRef.current.length - 1 });
      return;
    }
    if (!mod && !e.altKey && e.key.length === 1) {
      // Typing starts editing with that character, as in Excel.
      e.preventDefault();
      startEdit(a, e.key);
    }
  };

  // ── Mouse ──
  const onCellMouseDown = useCallback(
    (r: number, c: number, e: React.MouseEvent) => {
      if (e.button !== 0) return;
      if (editingRef.current && (editingRef.current.r !== r || editingRef.current.c !== c)) return; // editor's blur commits
      if (e.shiftKey) {
        if (!anchorRef.current) setAnchor(activeRef.current);
        setActive({ r, c });
      } else {
        setAnchor({ r, c });
        setActive({ r, c });
        dragging.current = true;
      }
      focusGrid();
    },
    [],
  );
  const onCellMouseEnter = useCallback((r: number, c: number) => {
    if (dragging.current) setActive({ r, c });
  }, []);
  useEffect(() => {
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);
  const onCellDoubleClick = useCallback((r: number, c: number) => startEdit({ r, c }), [startEdit]);
  const onOpenReserved = useCallback((id: string, el: HTMLElement) => setReservedFor({ id, rect: el.getBoundingClientRect() }), []);

  // Keep the cursor inside the visible rows after a filter change.
  useLayoutEffect(() => {
    setActive((a) => ({ r: Math.max(0, Math.min(order.length - 1, a.r)), c: Math.max(0, Math.min(cols.length - 1, a.c)) }));
    setAnchor(null);
  }, [order.length, cols.length]);

  // ?focus=<id> from a low-stock alert.
  useEffect(() => {
    if (!props.focusId) return;
    const r = orderRef.current.indexOf(props.focusId);
    if (r >= 0) {
      const c = Math.max(0, colsRef.current.findIndex((x) => x.key === 'onHand'));
      setActive({ r, c });
      requestAnimationFrame(() => scrollToCell({ r, c }));
    }
  }, [props.focusId, scrollToCell]);

  // ── Bulk edit ──
  const runBulk = async (op: BulkOp, label: string) => {
    const ids = [...selected].filter((id) => byId.has(id));
    if (!ids.length) return;
    try {
      const res = await bulkInventory(ids, op);
      replaceRows(res.results.map((r) => r.row).filter((r): r is InventoryRow => !!r));
      if (res.failed.length) {
        toast({ kind: 'warn', text: `${label}: ${res.ok} saved, ${res.failed.length} not: ${res.failed.slice(0, 3).map((f) => `${f.title} (${f.message})`).join('; ')}${res.failed.length > 3 ? '…' : ''}` });
      } else toast({ kind: 'success', text: `${label}: ${res.ok} item${res.ok === 1 ? '' : 's'} saved.` });
    } catch {
      toast({ kind: 'error', text: 'Could not reach the server. Nothing was saved.' });
    }
  };

  const onCreated = (row: InventoryRow, notes: string[]) => {
    setRows((cur) => [row, ...cur]);
    setQuick('all');
    setQuery('');
    setSort(null);
    setSnapshot((cur) => [row, ...cur.filter((r) => r.id !== row.id)]);
    for (const n of notes) toast({ kind: 'info', text: n });
    toast({ kind: 'success', text: `Added ${row.sku ? `${row.sku} · ` : ''}${row.title} as a ${row.status === 'PUBLISHED' ? 'published' : 'draft'} listing.` });
    requestAnimationFrame(() => {
      const r = orderRef.current.indexOf(row.id);
      if (r >= 0) moveTo({ r, c: Math.max(0, colsRef.current.findIndex((c) => c.key === 'onHand')) });
      focusGrid();
    });
  };

  // ── Totals ──
  const totals = useMemo(() => {
    let onHand = 0;
    let reserved = 0;
    let atCost = 0;
    let atPrice = 0;
    let missingCost = 0;
    for (const id of order) {
      const r = byId.get(id);
      if (!r) continue;
      onHand += r.onHand;
      reserved += r.reserved;
      if (r.costCents !== null) atCost += r.costCents * r.onHand;
      else if (r.onHand > 0) missingCost++;
      if (r.priceCents !== null) atPrice += r.priceCents * r.available;
    }
    return { onHand, reserved, atCost, atPrice, missingCost };
  }, [order, byId]);

  const exportForm = useRef<HTMLFormElement>(null);
  const [exportIds, setExportIds] = useState('');
  const [exportFormat, setExportFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const doExport = (format: 'xlsx' | 'csv', ids: string[] | null) => {
    setExportFormat(format);
    setExportIds(ids ? ids.join(',') : '');
    requestAnimationFrame(() => exportForm.current?.submit());
  };
  const filtered = quick !== 'all' || query.trim() !== '';
  const missingSku = rows.filter((r) => !r.sku).length;

  const tableWidth = CHECK_W + cols.reduce((s, c) => s + c.width, 0) + ACTIONS_W;
  const stickyLeft = useMemo(() => {
    const out = new Map<ColumnKey, number>();
    let x = CHECK_W;
    for (const c of cols) {
      if (c.key !== 'sku' && c.key !== 'title') break;
      out.set(c.key, x);
      x += c.width;
    }
    return out;
  }, [cols]);

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              refilter();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'ArrowDown') {
                e.preventDefault();
                moveTo({ r: 0, c: activeRef.current.c });
                focusGrid();
              }
            }}
            placeholder="Search SKU, part number, name, supplier, location…"
            aria-label="Search the inventory"
            className="w-full h-9 rounded-full border border-border bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
        <div className="flex rounded-full border border-border p-0.5 text-xs font-semibold" role="group" aria-label="Which listings">
          <Link href="/admin/inventory" className={`px-3 py-1.5 rounded-full ${props.scope === 'own' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>Own stock</Link>
          <Link href="/admin/inventory?scope=all" className={`px-3 py-1.5 rounded-full ${props.scope === 'all' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>All listings</Link>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {perms.edit && (
            <button type="button" onClick={() => setNewItemOpen(true)} className="h-9 px-4 rounded-full bg-primary text-primary-foreground text-sm font-semibold inline-flex items-center gap-1.5">
              <Plus className="h-4 w-4" /> New item
            </button>
          )}
          <ExportMenu onExport={doExport} filteredCount={filtered ? order.length : null} />
          {perms.import && (
            <Link href="/admin/inventory/import" className="h-9 px-3 rounded-full border border-border text-sm font-semibold inline-flex items-center gap-1.5 hover:bg-muted">
              <Upload className="h-4 w-4" /> Import
            </Link>
          )}
          <Link href="/admin/inventory/suppliers" className="h-9 px-3 rounded-full border border-border text-sm font-semibold inline-flex items-center gap-1.5 hover:bg-muted">
            <Truck className="h-4 w-4" /> Suppliers
          </Link>
          {perms.settings && (
            <Link href="/admin/inventory/settings" className="h-9 px-3 rounded-full border border-border text-sm font-semibold inline-flex items-center gap-1.5 hover:bg-muted" aria-label="Inventory settings">
              <Settings2 className="h-4 w-4" /> Settings
            </Link>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {QUICK_FILTERS.filter((f) => !f.cost || perms.cost).map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => {
              setQuick(f.key);
              refilter();
            }}
            className={`px-3 py-1 rounded-full text-xs font-semibold ${
              quick === f.key ? 'bg-foreground text-background' : 'bg-foreground/5 hover:bg-foreground/10 text-foreground'
            } ${f.key === 'low' && counts.low > 0 && quick !== 'low' ? 'ring-1 ring-amber-500/60' : ''}`}
          >
            {f.label} <span className="opacity-60 tabular-nums ml-0.5">{counts[f.key] ?? 0}</span>
          </button>
        ))}
        {stale && (
          <button type="button" onClick={refilter} className="ml-1 text-xs font-semibold text-primary underline underline-offset-2">
            Refresh filter
          </button>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {perms.edit && missingSku > 0 && (
            <button
              type="button"
              onClick={async () => {
                const ids = rows.filter((r) => !r.sku).map((r) => r.id);
                try {
                  const res = await bulkInventory(ids, { type: 'assignSku' });
                  replaceRows(res.results.map((r) => r.row).filter((r): r is InventoryRow => !!r));
                  toast({ kind: 'success', text: `Assigned ${res.ok} SKU${res.ok === 1 ? '' : 's'}.` });
                } catch {
                  toast({ kind: 'error', text: 'Could not reach the server.' });
                }
              }}
              className="px-3 py-1 rounded-full text-xs font-semibold border border-border hover:bg-muted"
            >
              Assign SKUs to {missingSku} item{missingSku === 1 ? '' : 's'}
            </button>
          )}
          <div className="relative">
            <button type="button" onClick={() => setShowCols((v) => !v)} className="px-3 py-1 rounded-full text-xs font-semibold border border-border hover:bg-muted inline-flex items-center gap-1" aria-expanded={showCols}>
              <Columns3 className="h-3.5 w-3.5" /> Columns
            </button>
            {showCols && (
              <div className="absolute right-0 z-40 mt-1 w-56 rounded-xl border border-border bg-card p-2 shadow-xl" onMouseLeave={() => setShowCols(false)}>
                {allCols.map((c) => (
                  <label key={c.key} className="flex items-center gap-2 px-2 py-1 text-sm rounded hover:bg-muted cursor-pointer">
                    <input type="checkbox" checked={!hidden.has(c.key)} onChange={() => toggleColumn(c.key)} />
                    {c.header}
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="relative">
            <button type="button" onClick={() => setShowKeys((v) => !v)} className="px-3 py-1 rounded-full text-xs font-semibold border border-border hover:bg-muted inline-flex items-center gap-1" aria-expanded={showKeys}>
              <Keyboard className="h-3.5 w-3.5" /> Keys
            </button>
            {showKeys && <KeysHelp onClose={() => setShowKeys(false)} />}
          </div>
        </div>
      </div>

      {selected.size > 0 && perms.edit && (
        <BulkBar
          count={selected.size}
          perms={perms}
          suppliers={suppliers}
          categories={props.categories}
          locations={locations}
          onRun={runBulk}
          onExport={(f) => doExport(f, [...selected])}
          onClear={() => setSelected(new Set())}
        />
      )}

      {/* Desktop / tablet: the sheet */}
      <div className="hidden md:block">
        <div
          ref={scrollRef}
          className="relative overflow-auto rounded-xl border border-border bg-card max-h-[calc(100vh-290px)] min-h-[320px]"
        >
          <div ref={gridRef} tabIndex={0} onKeyDown={onKeyDown} className="outline-none" role="grid" aria-rowcount={order.length + 1} aria-colcount={cols.length} aria-label="Inventory sheet" data-testid="inventory-grid">
            <table className="border-separate border-spacing-0 text-[13px]" style={{ width: tableWidth, tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: CHECK_W }} />
                {cols.map((c) => (
                  <col key={c.key} style={{ width: c.width }} />
                ))}
                <col style={{ width: ACTIONS_W }} />
              </colgroup>
              <thead>
                <tr role="row">
                  <th className="sticky top-0 left-0 z-30 bg-muted border-b border-r border-border h-9" style={{ width: CHECK_W }}>
                    <input
                      type="checkbox"
                      aria-label="Select all shown rows"
                      checked={order.length > 0 && order.every((id) => selected.has(id))}
                      onChange={(e) => setSelected(e.target.checked ? new Set(order) : new Set())}
                    />
                  </th>
                  {cols.map((c, ci) => {
                    const left = stickyLeft.get(c.key);
                    const sorted = sort?.key === c.key ? sort.dir : null;
                    return (
                      <th
                        key={c.key}
                        role="columnheader"
                        aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : 'none'}
                        title={[c.hint, c.cost ? 'Admin only: never shown on the site.' : null, 'Click to sort.'].filter(Boolean).join(' ')}
                        onClick={() => {
                          setSort((s) => (s?.key !== c.key ? { key: c.key, dir: 'asc' } : s.dir === 'asc' ? { key: c.key, dir: 'desc' } : null));
                          refilter();
                        }}
                        className={`sticky top-0 ${left !== undefined ? 'z-30' : 'z-20'} bg-muted border-b border-r border-border px-2 h-9 text-left text-[11px] font-bold uppercase tracking-wide text-muted-foreground select-none cursor-pointer hover:text-foreground ${
                          c.kind === 'money' || c.kind === 'int' || ['reserved', 'available', 'margin', 'marginPct'].includes(c.key) ? 'text-right' : ''
                        } ${active.c === ci ? 'text-foreground' : ''}`}
                        style={left !== undefined ? { left } : undefined}
                      >
                        <span className="inline-flex items-center gap-1">
                          {c.cost && <EyeOff className="h-3 w-3 shrink-0" aria-label="Admin only" />}
                          {c.header}
                          {sorted === 'asc' && <ArrowUp className="h-3 w-3" />}
                          {sorted === 'desc' && <ArrowDown className="h-3 w-3" />}
                        </span>
                      </th>
                    );
                  })}
                  <th className="sticky top-0 z-20 bg-muted border-b border-border" style={{ width: ACTIONS_W }} />
                </tr>
              </thead>
              <tbody>
                {order.map((id, r) => {
                  const row = byId.get(id);
                  if (!row) return null;
                  const inRange = r >= range.r0 && r <= range.r1;
                  return (
                    <GridRow
                      key={id}
                      row={row}
                      r={r}
                      cols={cols}
                      stickyLeft={stickyLeft}
                      activeC={active.r === r ? active.c : -1}
                      rangeC0={inRange && (anchor !== null) ? range.c0 : -1}
                      rangeC1={inRange && (anchor !== null) ? range.c1 : -1}
                      editing={editing && editing.r === r ? editing : null}
                      states={cellStates[id]}
                      pending={pendingText[id]}
                      selected={selected.has(id)}
                      rules={rules}
                      canEdit={perms.edit}
                      suppliers={suppliers}
                      brands={brands}
                      categories={props.categories}
                      locations={locations}
                      onToggle={toggleRow}
                      onMouseDown={onCellMouseDown}
                      onMouseEnter={onCellMouseEnter}
                      onDoubleClick={onCellDoubleClick}
                      onCommit={commitEdit}
                      onCancel={cancelEdit}
                      onHistory={setHistoryFor}
                      onReserved={onOpenReserved}
                    />
                  );
                })}
              </tbody>
            </table>
            {order.length === 0 && (
              <div className="p-10 text-center text-sm text-muted-foreground">
                {rows.length === 0 ? 'No items yet. Add one with "New item", or import a spreadsheet.' : 'No item matches this search or filter.'}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Phone: cards with quick stock buttons */}
      <MobileCards
        ids={order}
        byId={byId}
        rules={rules}
        perms={perms}
        onSave={save}
        onHistory={setHistoryFor}
      />

      {/* Totals */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground px-1" data-testid="inventory-totals">
        <span><b className="text-foreground tabular-nums">{order.length}</b> item{order.length === 1 ? '' : 's'} shown</span>
        <span><b className="text-foreground tabular-nums">{totals.onHand}</b> units on hand</span>
        <span><b className="text-foreground tabular-nums">{totals.reserved}</b> reserved</span>
        {perms.cost && (
          <span>
            Stock value at cost <b className="text-foreground tabular-nums">€{formatCents(totals.atCost)}</b>
            {totals.missingCost > 0 && <> ({totals.missingCost} without a cost)</>}
          </span>
        )}
        <span>Available at selling price <b className="text-foreground tabular-nums">€{formatCents(totals.atPrice)}</b></span>
        <span className="ml-auto hidden md:inline">Double-click or start typing to edit · Enter/Tab moves · Ctrl+C / Ctrl+V work with Excel · Ctrl+Z undoes</span>
      </div>

      <form ref={exportForm} method="post" action="/admin/inventory/export" className="hidden">
        <input type="hidden" name="format" value={exportFormat} />
        <input type="hidden" name="scope" value={props.scope} />
        <input type="hidden" name="ids" value={exportIds} />
      </form>

      {historyFor && <HistoryDrawer id={historyFor} row={byId.get(historyFor) ?? null} onClose={() => setHistoryFor(null)} />}
      {reservedFor && <ReservedPopover id={reservedFor.id} rect={reservedFor.rect} onClose={() => setReservedFor(null)} />}
      {newItemOpen && (
        <NewItemDialog
          categories={props.categories}
          defaults={{ mode: rules.newMode, condition: rules.newCondition }}
          canPublish={perms.approve}
          onClose={() => setNewItemOpen(false)}
          onCreated={(row, notes) => {
            setNewItemOpen(false);
            onCreated(row, notes);
          }}
        />
      )}
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((x) => x.filter((t) => t.id !== id))} />
    </div>
  );
}

function mergeNames(list: string[], add: (string | null)[]): string[] {
  const set = new Map(list.map((x) => [x.toLowerCase(), x]));
  let changed = false;
  for (const a of add) {
    if (a && !set.has(a.toLowerCase())) {
      set.set(a.toLowerCase(), a);
      changed = true;
    }
  }
  return changed ? [...set.values()].sort((a, b) => a.localeCompare(b)) : list;
}

// ─── One row ────────────────────────────────────────────────

type RowProps = {
  row: InventoryRow;
  r: number;
  cols: ColumnDef[];
  stickyLeft: Map<ColumnKey, number>;
  activeC: number;
  rangeC0: number;
  rangeC1: number;
  editing: Editing | null;
  states: Record<string, CellState> | undefined;
  pending: Record<string, string> | undefined;
  selected: boolean;
  rules: GridRules;
  canEdit: boolean;
  suppliers: string[];
  brands: string[];
  categories: { name: string; slug: string }[];
  locations: string[];
  onToggle: (id: string) => void;
  onMouseDown: (r: number, c: number, e: React.MouseEvent) => void;
  onMouseEnter: (r: number, c: number) => void;
  onDoubleClick: (r: number, c: number) => void;
  onCommit: (text: string, move: 'down' | 'up' | 'right' | 'left' | 'none') => void;
  onCancel: () => void;
  onHistory: (id: string) => void;
  onReserved: (id: string, el: HTMLElement) => void;
};

const GridRow = memo(function GridRow(p: RowProps) {
  const { row, r, cols } = p;
  const low = isLow(row, p.rules.lowDefault);
  return (
    <tr role="row" aria-rowindex={r + 2} className={`group ${p.selected ? 'bg-primary/5' : ''}`} data-row={row.id}>
      <td className="sticky left-0 z-10 border-b border-r border-border text-center bg-card">
        {/* Frozen cells stay opaque (bg-card); the tint sits on top so scrolled cells never show through. */}
        <span aria-hidden className={`pointer-events-none absolute inset-0 ${p.selected ? 'bg-primary/10' : 'group-hover:bg-muted/60'}`} />
        <input className="relative" type="checkbox" aria-label={`Select ${row.title}`} checked={p.selected} onChange={() => p.onToggle(row.id)} />
      </td>
      {cols.map((col, c) => {
        const key = ck(row.id, col.key);
        const st = p.states?.[col.key];
        const pending = p.pending?.[col.key];
        const isActive = p.activeC === c;
        const inRange = p.rangeC0 >= 0 && c >= p.rangeC0 && c <= p.rangeC1;
        const left = p.stickyLeft.get(col.key);
        const isEditing = p.editing && p.editing.c === c;
        const numeric = col.kind === 'money' || col.kind === 'int' || ['reserved', 'available', 'margin', 'marginPct'].includes(col.key);
        const readOnly = !col.editable;
        const sticky = left !== undefined;
        let bg = 'group-hover:bg-muted/60';
        if (readOnly) bg = 'bg-muted/30 group-hover:bg-muted/60';
        if (p.selected) bg = 'bg-primary/5';
        if (inRange) bg = 'bg-primary/10';
        if (st?.s === 'saved') bg = 'bg-emerald-500/15';
        if (st?.s === 'error') bg = 'bg-red-500/10';
        if (st?.s === 'conflict') bg = 'bg-amber-500/15';
        return (
          <td
            key={col.key}
            role="gridcell"
            aria-selected={isActive || inRange}
            aria-readonly={readOnly || undefined}
            data-cell={key}
            title={st?.msg ?? (readOnly ? col.hint : undefined)}
            onMouseDown={(e) => p.onMouseDown(r, c, e)}
            onMouseEnter={() => p.onMouseEnter(r, c)}
            onDoubleClick={() => p.onDoubleClick(r, c)}
            className={`relative h-9 border-b border-r border-border px-2 ${numeric ? 'text-right tabular-nums' : ''} ${sticky ? 'bg-card' : bg} ${
              sticky ? 'sticky z-10' : ''
            } ${isActive ? 'outline outline-2 -outline-offset-2 outline-primary z-[15]' : ''} ${st?.s === 'error' ? 'outline outline-1 -outline-offset-1 outline-red-500' : ''} ${
              st?.s === 'conflict' ? 'outline outline-1 -outline-offset-1 outline-amber-500' : ''
            } transition-colors duration-500`}
            style={left !== undefined ? { left } : undefined}
          >
            {sticky && <span aria-hidden className={`pointer-events-none absolute inset-0 transition-colors duration-500 ${bg}`} />}
            {isEditing ? (
              <CellEditor
                col={col}
                initial={p.editing!.text}
                fresh={p.editing!.fresh}
                options={optionsFor(col.key, p)}
                onCommit={p.onCommit}
                onCancel={p.onCancel}
              />
            ) : (
              <div className={`relative truncate leading-9 ${st?.s === 'saving' ? 'opacity-60' : ''}`}>
                {st?.s === 'saving' && <Loader2 className="inline h-3 w-3 mr-1 animate-spin" />}
                {pending !== undefined ? pending : <CellContent row={row} col={col} low={low} rules={p.rules} onReserved={p.onReserved} />}
              </div>
            )}
          </td>
        );
      })}
      <td className="border-b border-border text-center bg-card group-hover:bg-muted/60">
        <button type="button" onClick={() => p.onHistory(row.id)} className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground" aria-label={`History of ${row.title}`} title="History">
          <History className="h-4 w-4" />
        </button>
      </td>
    </tr>
  );
});

function optionsFor(key: ColumnKey, p: { suppliers: string[]; brands: string[]; categories: { name: string }[]; locations: string[] }): { list: string[]; free: boolean } | null {
  switch (key) {
    case 'condition':
    case 'mode':
    case 'status':
      return { list: enumOptions(key).map((o) => o.label), free: false };
    case 'supplier':
      return { list: p.suppliers, free: true };
    case 'brand':
      return { list: p.brands, free: true };
    case 'category':
      return { list: p.categories.map((c) => c.name), free: false };
    case 'location':
      return { list: p.locations, free: true };
    default:
      return null;
  }
}

function CellContent({ row, col, low, rules, onReserved }: { row: InventoryRow; col: ColumnDef; low: boolean; rules: GridRules; onReserved: (id: string, el: HTMLElement) => void }) {
  const text = displayText(row, col.key);
  switch (col.key) {
    case 'title':
      return (
        <span className="inline-flex items-center gap-2 max-w-full">
          {row.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={row.image} alt="" loading="lazy" className="h-6 w-6 rounded object-cover shrink-0 bg-muted" />
          ) : (
            <span className="h-6 w-6 rounded bg-muted shrink-0" />
          )}
          <span className="truncate font-medium">{text}</span>
          {row.shop && <span className="shrink-0 rounded bg-foreground/5 px-1.5 text-[10px] font-semibold text-muted-foreground">{row.shop}</span>}
        </span>
      );
    case 'mpn':
      return row.mpnFromSpecs ? (
        <span className="italic text-muted-foreground" title="Read from the listing's specs. Press F2 then Enter to keep it.">{text}</span>
      ) : (
        <>{text}</>
      );
    case 'status': {
      const tone = row.status === 'PUBLISHED' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : row.status === 'ARCHIVED' ? 'bg-foreground/10 text-muted-foreground' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
      return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{text}</span>;
    }
    case 'reserved':
      return row.reserved > 0 ? (
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => onReserved(row.id, e.currentTarget)}
          className="font-semibold text-primary underline underline-offset-2"
          title="Show the orders"
        >
          {row.reserved}
        </button>
      ) : (
        <span className="text-muted-foreground">0</span>
      );
    case 'available':
      return (
        <span className={`font-semibold ${row.available <= 0 ? 'text-red-600 dark:text-red-400' : low ? 'text-amber-600 dark:text-amber-400' : ''}`} title={row.available <= 0 ? 'Nothing available to sell' : low ? 'Low stock' : undefined}>
          {row.available}
        </span>
      );
    case 'priceCents':
      return (
        <span className="inline-flex items-center justify-end gap-1.5 w-full">
          {row.priceInternal && row.priceCents !== null && (
            <span className="rounded bg-foreground/5 px-1 text-[10px] font-semibold text-muted-foreground" title="Quote-only item: this price is internal and not shown on the site.">
              internal
            </span>
          )}
          {text}
        </span>
      );
    case 'margin':
    case 'marginPct': {
      const m = marginOf(row);
      const bad = m.cents !== null && (m.cents < 0 || (m.pct !== null && m.pct < rules.minMarginPct));
      return <span className={bad ? 'font-semibold text-red-600 dark:text-red-400' : m.cents !== null ? 'text-emerald-700 dark:text-emerald-400' : ''}>{text}</span>;
    }
    case 'link':
      return (
        <a
          href={`/marketplace/${row.slug}`}
          target="_blank"
          rel="noreferrer"
          tabIndex={-1}
          onMouseDown={(e) => e.stopPropagation()}
          className="inline-flex items-center text-primary hover:underline"
          aria-label={`Open the listing of ${row.title}`}
          title={row.status === 'PUBLISHED' ? 'Open the listing' : 'Open the listing (preview: not public)'}
        >
          <SquareArrowOutUpRight className="h-4 w-4" />
        </a>
      );
    default:
      return <>{text}</>;
  }
}

// ─── Cell editor ────────────────────────────────────────────

function CellEditor({
  col,
  initial,
  fresh,
  options,
  onCommit,
  onCancel,
}: {
  col: ColumnDef;
  initial: string;
  fresh: boolean;
  options: { list: string[]; free: boolean } | null;
  onCommit: (text: string, move: 'down' | 'up' | 'right' | 'left' | 'none') => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [hi, setHi] = useState(0);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (fresh) el.setSelectionRange(el.value.length, el.value.length);
    else el.select();
  }, [fresh]);

  const matches = useMemo(() => {
    if (!options) return [];
    const t = text.trim().toLowerCase();
    const list = options.list.filter((o) => !t || o.toLowerCase().includes(t));
    return list.slice(0, 50);
  }, [options, text]);
  const exact = options?.list.find((o) => o.toLowerCase() === text.trim().toLowerCase());
  const showAdd = !!options?.free && !!text.trim() && !exact;

  const finish = (move: 'down' | 'up' | 'right' | 'left' | 'none', pick?: string) => {
    if (done.current) return;
    done.current = true;
    let value = pick ?? text;
    if (options && !options.free && pick === undefined) {
      // Closed lists: take the highlighted match (or keep what was typed when it is exact).
      value = exact ?? matches[hi] ?? text;
    }
    onCommit(value, move);
  };

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      done.current = true;
      onCancel();
      return;
    }
    if (options && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const max = matches.length - 1 + (showAdd ? 1 : 0);
      setHi((h) => Math.max(0, Math.min(max, h + (e.key === 'ArrowDown' ? 1 : -1))));
      return;
    }
    if (e.key === 'Enter' && !(col.kind === 'longtext' && e.shiftKey)) {
      e.preventDefault();
      const move = e.shiftKey ? 'up' : 'down';
      if (options && hi < matches.length && matches.length && (text.trim() === '' ? false : true) && !exact) finish(move, matches[hi]);
      else finish(move);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      finish(e.shiftKey ? 'left' : 'right');
    }
  };

  const common = {
    value: text,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setText(e.target.value);
      setHi(0);
    },
    onKeyDown: onKey,
    onBlur: () => finish('none'),
    'aria-label': `Edit ${col.header}`,
  };
  const editorClass = `absolute inset-0 w-full h-full px-2 bg-background text-foreground outline outline-2 -outline-offset-2 outline-primary ${
    col.kind === 'money' || col.kind === 'int' ? 'text-right tabular-nums' : ''
  }`;
  return (
    <>
      {col.kind === 'longtext' ? (
        <textarea ref={ref} {...common} rows={3} className={`${editorClass} h-24 py-1.5 z-30 resize-none shadow-lg`} />
      ) : (
        <input ref={ref} {...common} className={editorClass} inputMode={col.kind === 'money' ? 'decimal' : col.kind === 'int' ? 'numeric' : undefined} autoComplete="off" />
      )}
      {options && (matches.length > 0 || showAdd) && (
        <ul role="listbox" className="absolute left-0 top-full z-40 mt-0.5 max-h-60 min-w-full w-max max-w-xs overflow-auto rounded-lg border border-border bg-card py-1 text-sm shadow-xl text-left">
          {matches.map((m, i) => (
            <li
              key={m}
              role="option"
              aria-selected={i === hi}
              onMouseDown={(e) => {
                e.preventDefault();
                finish('none', m);
              }}
              className={`px-3 py-1.5 cursor-pointer ${i === hi ? 'bg-primary/10 text-foreground' : 'hover:bg-muted'}`}
            >
              {m}
            </li>
          ))}
          {showAdd && (
            <li
              role="option"
              aria-selected={hi === matches.length}
              onMouseDown={(e) => {
                e.preventDefault();
                finish('none', text.trim());
              }}
              className={`px-3 py-1.5 cursor-pointer border-t border-border text-primary font-semibold ${hi === matches.length ? 'bg-primary/10' : 'hover:bg-muted'}`}
            >
              + Add “{text.trim()}”
            </li>
          )}
        </ul>
      )}
    </>
  );
}

// ─── Export menu, bulk bar, help ────────────────────────────

function ExportMenu({ onExport, filteredCount }: { onExport: (f: 'xlsx' | 'csv', ids: string[] | null) => void; filteredCount: number | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className="h-9 px-3 rounded-full border border-border text-sm font-semibold inline-flex items-center gap-1.5 hover:bg-muted" aria-expanded={open}>
        <Download className="h-4 w-4" /> Export
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-64 rounded-xl border border-border bg-card p-1.5 shadow-xl text-sm" onMouseLeave={() => setOpen(false)}>
          <button type="button" className="w-full text-left px-3 py-2 rounded-lg hover:bg-muted" onClick={() => { setOpen(false); onExport('xlsx', null); }}>
            <b>Excel (.xlsx)</b> <span className="text-muted-foreground">all items</span>
          </button>
          <button type="button" className="w-full text-left px-3 py-2 rounded-lg hover:bg-muted" onClick={() => { setOpen(false); onExport('csv', null); }}>
            <b>CSV</b> <span className="text-muted-foreground">all items</span>
          </button>
          {filteredCount !== null && (
            <p className="px-3 pt-2 pb-1 text-xs text-muted-foreground">Only the {filteredCount} shown items: select them with the header checkbox, then use Export in the selection bar.</p>
          )}
          <p className="px-3 pt-1 pb-1.5 text-xs text-muted-foreground">Edit the Excel file and bring it back with Import: you see every change before it is applied.</p>
        </div>
      )}
    </div>
  );
}

function BulkBar({
  count,
  perms,
  suppliers,
  categories,
  locations,
  onRun,
  onExport,
  onClear,
}: {
  count: number;
  perms: GridPerms;
  suppliers: string[];
  categories: { name: string }[];
  locations: string[];
  onRun: (op: BulkOp, label: string) => Promise<void>;
  onExport: (f: 'xlsx' | 'csv') => void;
  onClear: () => void;
}) {
  const fields: { key: EditableField; label: string }[] = [
    { key: 'location', label: 'Location' },
    { key: 'supplier', label: 'Supplier' },
    { key: 'condition', label: 'Condition' },
    { key: 'mode', label: 'Sale mode' },
    ...(perms.approve ? [{ key: 'status' as EditableField, label: 'Site status' }] : []),
    { key: 'category', label: 'Category' },
    { key: 'brand', label: 'Brand' },
    { key: 'lowStockAt', label: 'Low at' },
  ];
  const [field, setField] = useState<EditableField>('location');
  const [value, setValue] = useState('');
  const [pct, setPct] = useState('');
  const [delta, setDelta] = useState('');
  const [busy, setBusy] = useState(false);
  const opts = enumOptions(field);
  const list = field === 'supplier' ? suppliers : field === 'location' ? locations : field === 'category' ? categories.map((c) => c.name) : [];
  const run = async (op: BulkOp, label: string) => {
    setBusy(true);
    await onRun(op, label);
    setBusy(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-sm" data-testid="bulk-bar">
      <b>{count} selected</b>
      <span className="text-muted-foreground">Set</span>
      <select value={field} onChange={(e) => { setField(e.target.value as EditableField); setValue(''); }} className="h-8 rounded-md border border-border bg-background px-2" aria-label="Field to set">
        {fields.map((f) => (
          <option key={f.key} value={f.key}>{f.label}</option>
        ))}
      </select>
      <span className="text-muted-foreground">to</span>
      {opts.length ? (
        <select value={value} onChange={(e) => setValue(e.target.value)} className="h-8 rounded-md border border-border bg-background px-2" aria-label="New value">
          <option value="">Choose…</option>
          {opts.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      ) : (
        <>
          <input value={value} onChange={(e) => setValue(e.target.value)} list="bulk-values" placeholder="(empty clears)" className="h-8 w-40 rounded-md border border-border bg-background px-2" aria-label="New value" />
          <datalist id="bulk-values">{list.map((v) => <option key={v} value={v} />)}</datalist>
        </>
      )}
      <button type="button" disabled={busy || (opts.length > 0 && !value)} onClick={() => run({ type: 'set', field, value: value.trim() === '' ? null : value }, fields.find((f) => f.key === field)!.label)} className="h-8 px-3 rounded-md bg-primary text-primary-foreground font-semibold disabled:opacity-50">
        Apply
      </button>
      <span className="mx-1 h-5 w-px bg-border" />
      <span className="text-muted-foreground">Price</span>
      <input value={pct} onChange={(e) => setPct(e.target.value)} placeholder="+10 %" className="h-8 w-20 rounded-md border border-border bg-background px-2" aria-label="Price change in percent" />
      <button type="button" disabled={busy || !pct.trim() || Number.isNaN(Number(pct.replace('%', '').replace(',', '.')))} onClick={() => run({ type: 'price', mode: 'percent', amount: Number(pct.replace('%', '').replace(',', '.')) }, `Price ${pct}%`)} className="h-8 px-3 rounded-md border border-border font-semibold hover:bg-muted disabled:opacity-50">
        Apply %
      </button>
      <span className="mx-1 h-5 w-px bg-border" />
      <span className="text-muted-foreground">On hand</span>
      <input value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="+1 / -1" className="h-8 w-20 rounded-md border border-border bg-background px-2" aria-label="Change on hand by" />
      <button type="button" disabled={busy || !/^[+-]?\d+$/.test(delta.trim())} onClick={() => run({ type: 'onHand', delta: Number(delta.trim()) }, `On hand ${delta}`)} className="h-8 px-3 rounded-md border border-border font-semibold hover:bg-muted disabled:opacity-50">
        Apply
      </button>
      <span className="mx-1 h-5 w-px bg-border" />
      <button type="button" disabled={busy} onClick={() => run({ type: 'assignSku' }, 'Assign SKUs')} className="h-8 px-3 rounded-md border border-border font-semibold hover:bg-muted">Assign SKUs</button>
      <button type="button" onClick={() => onExport('xlsx')} className="h-8 px-3 rounded-md border border-border font-semibold hover:bg-muted">Export</button>
      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
      <button type="button" onClick={onClear} className="ml-auto h-8 px-2 rounded-md text-muted-foreground hover:text-foreground inline-flex items-center gap-1"><X className="h-4 w-4" /> Clear</button>
    </div>
  );
}

function KeysHelp({ onClose }: { onClose: () => void }) {
  const keys: [string, string][] = [
    ['Arrows, Tab, Enter', 'Move (Shift = back / extend selection)'],
    ['Type, F2 or double-click', 'Edit the cell'],
    ['Enter / Tab', 'Save and move on'],
    ['Esc', 'Cancel the edit'],
    ['Delete', 'Empty the selected cells'],
    ['Ctrl+C / Ctrl+V', 'Copy and paste blocks with Excel'],
    ['Ctrl+Z', 'Undo the last change'],
    ['Shift+Space', 'Tick the row for bulk edit'],
    ['Ctrl+A', 'Select every cell'],
  ];
  return (
    <div className="absolute right-0 z-40 mt-1 w-80 rounded-xl border border-border bg-card p-3 shadow-xl text-sm" onMouseLeave={onClose}>
      <ul className="space-y-1">
        {keys.map(([k, v]) => (
          <li key={k} className="flex justify-between gap-3">
            <kbd className="font-mono text-xs bg-muted rounded px-1.5 py-0.5">{k}</kbd>
            <span className="text-muted-foreground text-right">{v}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Phone view ─────────────────────────────────────────────

function MobileCards({
  ids,
  byId,
  rules,
  perms,
  onSave,
  onHistory,
}: {
  ids: string[];
  byId: Map<string, InventoryRow>;
  rules: GridRules;
  perms: GridPerms;
  onSave: (edits: { id: string; changes: { field: EditableField; value: string | number | null; base?: string | number | null }[] }[]) => Promise<void>;
  onHistory: (id: string) => void;
}) {
  const [limit, setLimit] = useState(40);
  return (
    <div className="md:hidden space-y-2" data-testid="inventory-cards">
      {ids.slice(0, limit).map((id) => {
        const row = byId.get(id);
        if (!row) return null;
        const low = isLow(row, rules.lowDefault);
        return (
          <div key={id} className="rounded-xl border border-border bg-card p-3">
            <div className="flex items-start gap-3">
              {row.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={row.image} alt="" className="h-12 w-12 rounded-lg object-cover bg-muted shrink-0" />
              ) : (
                <div className="h-12 w-12 rounded-lg bg-muted shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold leading-snug line-clamp-2">{row.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {[row.sku, row.mpn, row.location ? `at ${row.location}` : null].filter(Boolean).join(' · ') || 'No SKU yet'}
                </p>
              </div>
              <button type="button" onClick={() => onHistory(id)} className="p-1.5 rounded text-muted-foreground" aria-label={`History of ${row.title}`}>
                <History className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-3 flex items-center gap-3">
              {perms.edit && (
                <button
                  type="button"
                  aria-label="One less on hand"
                  disabled={row.onHand <= row.reserved}
                  onClick={() => onSave([{ id, changes: [{ field: 'onHand', value: row.onHand - 1, base: row.onHand }] }])}
                  className="h-10 w-10 rounded-full border border-border inline-flex items-center justify-center disabled:opacity-40"
                >
                  <Minus className="h-4 w-4" />
                </button>
              )}
              <div className="text-center min-w-[64px]">
                <p className="text-lg font-bold tabular-nums leading-none">{row.onHand}</p>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">on hand</p>
              </div>
              {perms.edit && (
                <button
                  type="button"
                  aria-label="One more on hand"
                  onClick={() => onSave([{ id, changes: [{ field: 'onHand', value: row.onHand + 1, base: row.onHand }] }])}
                  className="h-10 w-10 rounded-full border border-border inline-flex items-center justify-center"
                >
                  <Plus className="h-4 w-4" />
                </button>
              )}
              <div className="ml-auto text-right text-xs">
                <p className={row.available <= 0 ? 'font-semibold text-red-600' : low ? 'font-semibold text-amber-600' : ''}>{row.available} available</p>
                {row.reserved > 0 && <p className="text-muted-foreground">{row.reserved} reserved</p>}
                <p className="font-semibold">{row.priceCents !== null ? `€${formatCents(row.priceCents)}${row.priceInternal ? ' (internal)' : ''}` : 'No price'}</p>
              </div>
            </div>
          </div>
        );
      })}
      {ids.length > limit && (
        <button type="button" onClick={() => setLimit((l) => l + 40)} className="w-full h-10 rounded-xl border border-border text-sm font-semibold">
          Show more ({ids.length - limit} left)
        </button>
      )}
      {ids.length === 0 && <p className="text-sm text-muted-foreground p-6 text-center">No item matches.</p>}
      <p className="text-xs text-muted-foreground px-1 flex items-center gap-1"><Check className="h-3 w-3" /> Full editing is on a wider screen; here you can count stock.</p>
    </div>
  );
}
