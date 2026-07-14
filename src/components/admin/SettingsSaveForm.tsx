'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Save, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Result = { ok: boolean; message: string } | null;

/**
 * Wraps a settings tab's form. Uses useActionState so the save happens in place
 * (no navigation / scroll jump) and shows an inline "Saved ✓" or error right by
 * the button — so the operator can always tell whether the save landed. A
 * missing settings:write permission now shows as a message instead of the old
 * silent redirect to /admin (which read as "the page jumped away on save").
 */
export function SettingsSaveForm({
  action,
  group,
  saveNote,
  children,
}: {
  action: (prev: Result, formData: FormData) => Promise<Result>;
  group: string;
  saveNote?: string;
  children: React.ReactNode;
}) {
  const [state, formAction] = useActionState(action, null);

  return (
    <form action={formAction} className="rounded-2xl border border-border bg-card p-6 space-y-5">
      {children}
      <div className="flex items-center gap-3 pt-2 border-t border-border flex-wrap">
        <SaveButton group={group} />
        {state && (
          <span
            className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
              state.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
            }`}
          >
            {state.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            {state.message}
          </span>
        )}
        {saveNote && <p className="text-[11px] text-muted-foreground">{saveNote}</p>}
      </div>
    </form>
  );
}

function SaveButton({ group }: { group: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending} className="rounded-full font-semibold">
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
      {pending ? 'Saving…' : `Save ${group}`}
    </Button>
  );
}
