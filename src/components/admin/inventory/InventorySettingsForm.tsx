'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RotateCcw } from 'lucide-react';
import { saveInventorySettings } from '@/app/admin/inventory/actions';

export type SettingField = {
  key: string;
  group: string;
  label: string;
  hint: string;
  type: 'enum' | 'int' | 'bool' | 'text' | 'category';
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  suffix?: string;
  maxLength?: number;
  value: string;
  defaultValue: string;
  isDefault: boolean;
};

export function InventorySettingsForm({ fields }: { fields: SettingField[] }) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.value])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const groups = [...new Set(fields.map((f) => f.group))];
  const dirty = fields.some((f) => values[f.key] !== f.value);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await saveInventorySettings(values);
      setErrors(r.errors ?? {});
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) router.refresh();
    } catch {
      setMsg({ ok: false, text: 'Could not reach the server. Nothing was saved.' });
    }
    setBusy(false);
  };

  const set = (k: string, v: string) => setValues((x) => ({ ...x, [k]: v }));
  const input = 'h-9 rounded-lg border border-border bg-background px-3 text-sm';

  return (
    <form onSubmit={save} className="space-y-5">
      {groups.map((g) => (
        <section key={g} className="rounded-2xl border border-border bg-card p-5 space-y-4">
          <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">{g}</h2>
          {fields
            .filter((f) => f.group === g)
            .map((f) => (
              <div key={f.key} className="grid sm:grid-cols-[1fr_360px] gap-2 sm:gap-6 items-start" data-setting={f.key}>
                <div>
                  <label htmlFor={f.key} className="text-sm font-semibold">
                    {f.label}
                  </label>
                  <p className="text-xs text-muted-foreground mt-0.5">{f.hint}</p>
                  {errors[f.key] && <p className="text-xs text-red-600 mt-1">{errors[f.key]}</p>}
                </div>
                <div className="flex items-center gap-2">
                  {f.type === 'bool' ? (
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input id={f.key} type="checkbox" checked={values[f.key] === 'true'} onChange={(e) => set(f.key, e.target.checked ? 'true' : 'false')} />
                      {values[f.key] === 'true' ? 'On' : 'Off'}
                    </label>
                  ) : f.type === 'enum' || f.type === 'category' ? (
                    <select id={f.key} value={values[f.key]} onChange={(e) => set(f.key, e.target.value)} className={`${input} w-full`}>
                      {f.options!.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="flex items-center gap-1.5 w-full">
                      <input
                        id={f.key}
                        value={values[f.key]}
                        onChange={(e) => set(f.key, e.target.value)}
                        inputMode={f.type === 'int' ? 'numeric' : undefined}
                        maxLength={f.maxLength}
                        min={f.min}
                        max={f.max}
                        className={`${input} w-full ${errors[f.key] ? 'border-red-500' : ''}`}
                      />
                      {f.suffix && <span className="text-sm text-muted-foreground">{f.suffix}</span>}
                    </div>
                  )}
                  {values[f.key] !== f.defaultValue && (
                    <button type="button" onClick={() => set(f.key, f.defaultValue)} title={`Back to the default (${f.defaultValue || 'empty'})`} className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted" aria-label={`Reset ${f.label} to the default`}>
                      <RotateCcw className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
        </section>
      ))}
      <div className="sticky bottom-3 flex items-center gap-3 rounded-xl border border-border bg-card/95 backdrop-blur px-4 py-3 shadow-lg">
        {msg ? <p role={msg.ok ? 'status' : 'alert'} className={`text-sm ${msg.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600'}`}>{msg.text}</p> : <p className="text-sm text-muted-foreground">{dirty ? 'Unsaved changes.' : 'All saved.'}</p>}
        <button type="submit" disabled={busy || !dirty} className="ml-auto h-10 px-5 rounded-full bg-primary text-primary-foreground text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save settings
        </button>
      </div>
    </form>
  );
}
