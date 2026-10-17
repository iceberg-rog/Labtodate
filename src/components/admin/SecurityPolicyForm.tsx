'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Save, RotateCcw } from 'lucide-react';
import { useStepUp, type MaybeStepUp } from '@/components/security/useStepUp';

export type PolicyField = {
  key: string;
  group: string;
  groupLabel: string;
  type: 'bool' | 'int' | 'text' | 'set' | 'list';
  label: string;
  hint: string;
  value: boolean | number | string | string[];
  defaultValue: boolean | number | string | string[];
  isDefault: boolean;
  options?: Record<string, string>;
  min?: number;
  max?: number;
  unit?: string;
  placeholder?: string;
};

function show(v: PolicyField['value']): string {
  if (Array.isArray(v)) {
    if (!v.length) return '(none)';
    return v.length > 4 ? `${v.slice(0, 3).join(', ')} … (${v.length})` : v.join(', ');
  }
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return v === '' ? '(empty)' : String(v);
}

/** Admin → Settings → Security form. Read-only without security:manage. */
export function SecurityPolicyForm({
  fields,
  canEdit,
  action,
}: {
  fields: PolicyField[];
  canEdit: boolean;
  action: (fd: FormData) => Promise<MaybeStepUp>;
}) {
  const router = useRouter();
  const { run, dialog } = useStepUp();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<MaybeStepUp | null>(null);
  const [formKey, setFormKey] = useState(0);
  const groups = Array.from(new Map(fields.map((f) => [f.group, f.groupLabel])).entries());

  return (
    <form
      key={formKey}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        setMsg(null);
        start(async () => {
          const r = await run(() => action(fd)).catch(() => ({ ok: false, message: 'Saving failed — please try again.' }));
          setMsg(r);
          if (r.ok) router.refresh();
        });
      }}
      className="space-y-6"
    >
      {dialog}
      {groups.map(([group, label]) => (
        <section key={group} id={group} className="rounded-2xl border border-border bg-card p-5 space-y-4 scroll-mt-20">
          <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-muted-foreground">{label}</h2>
          {fields
            .filter((f) => f.group === group)
            .map((f) => (
              <div key={f.key} className="space-y-1.5" data-key={f.key}>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <label htmlFor={f.key} className="text-sm font-semibold">
                    {f.label}
                  </label>
                  <span className="text-[11px] text-muted-foreground">
                    {f.isDefault ? 'default' : `changed · default ${show(f.defaultValue)}`}
                  </span>
                </div>
                {f.type === 'bool' && (
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input id={f.key} type="checkbox" name={f.key} defaultChecked={f.value as boolean} disabled={!canEdit} className="h-4 w-4 accent-primary" />
                    Enabled
                  </label>
                )}
                {f.type === 'int' && (
                  <div className="flex items-center gap-2">
                    <input
                      id={f.key}
                      name={f.key}
                      type="number"
                      min={f.min}
                      max={f.max}
                      step={1}
                      required
                      defaultValue={f.value as number}
                      disabled={!canEdit}
                      className="w-32 h-9 px-3 rounded-lg border border-input bg-background text-sm"
                    />
                    {f.unit && <span className="text-xs text-muted-foreground">{f.unit}</span>}
                  </div>
                )}
                {f.type === 'text' && (
                  <input
                    id={f.key}
                    name={f.key}
                    type="text"
                    defaultValue={f.value as string}
                    placeholder={f.placeholder}
                    disabled={!canEdit}
                    className="w-full h-9 px-3 rounded-lg border border-input bg-background text-sm"
                  />
                )}
                {f.type === 'list' && (
                  <textarea
                    id={f.key}
                    name={f.key}
                    rows={Math.min(8, Math.max(3, (f.value as string[]).length + 1))}
                    defaultValue={(f.value as string[]).join('\n')}
                    placeholder={f.placeholder}
                    disabled={!canEdit}
                    spellCheck={false}
                    autoCapitalize="none"
                    className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm font-mono leading-5"
                  />
                )}
                {f.type === 'set' && f.options && (
                  <div className="grid sm:grid-cols-2 gap-1.5">
                    {Object.entries(f.options).map(([k, l]) => (
                      <label key={k} className="inline-flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name={f.key}
                          value={k}
                          defaultChecked={(f.value as string[]).includes(k)}
                          disabled={!canEdit}
                          className="h-4 w-4 accent-primary"
                        />
                        {l}
                      </label>
                    ))}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">{f.hint}</p>
              </div>
            ))}
        </section>
      ))}
      <div className="sticky bottom-0 z-10 -mx-1 flex items-center gap-3 flex-wrap rounded-2xl border border-border bg-card/95 backdrop-blur px-4 py-3">
        {canEdit ? (
          <>
            <button
              type="submit"
              disabled={pending}
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50"
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save security settings
            </button>
            <button
              type="button"
              onClick={() => {
                setFormKey((k) => k + 1);
                setMsg(null);
              }}
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-full border border-border text-sm font-semibold"
            >
              <RotateCcw className="h-4 w-4" /> Undo edits
            </button>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">Read-only — changing the security policy needs the security:manage permission.</p>
        )}
        {msg && (
          <p role={msg.ok ? 'status' : 'alert'} className={`text-sm font-semibold ${msg.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600 dark:text-red-400'}`}>
            {msg.message}
          </p>
        )}
      </div>
    </form>
  );
}
