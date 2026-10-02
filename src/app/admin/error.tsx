'use client';

import Link from 'next/link';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Admin error boundary. Without it an uncaught server-action / render error
 * replaced the WHOLE admin (nav included) with the root "This page couldn't
 * load" screen. Production builds redact the real message, so we show the
 * digest — the same id is written to Admin → Errors by src/instrumentation.ts.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="rounded-2xl border border-red-200 dark:border-red-800 bg-red-50/60 dark:bg-red-950/30 p-6 space-y-3 max-w-2xl">
      <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
        <AlertTriangle className="h-5 w-5" />
        <h1 className="text-lg font-bold">That action didn’t go through</h1>
      </div>
      <p className="text-sm text-foreground/80">
        The server rejected the request or hit an error. Nothing was saved by the step that failed.
        Go back, check the values and try again.
      </p>
      {error.digest && (
        <p className="text-xs text-muted-foreground">
          Reference: <code className="font-mono">{error.digest}</code> — the full message is listed under{' '}
          <Link href="/admin/errors" className="text-primary hover:underline">Admin → Errors</Link>.
        </p>
      )}
      <div className="flex items-center gap-2 pt-1">
        <Button type="button" size="sm" className="rounded-full" onClick={() => reset()}>
          <RotateCcw className="h-3.5 w-3.5" /> Try again
        </Button>
        <Button asChild variant="outline" size="sm" className="rounded-full">
          <Link href="/admin">Back to overview</Link>
        </Button>
      </div>
    </div>
  );
}
