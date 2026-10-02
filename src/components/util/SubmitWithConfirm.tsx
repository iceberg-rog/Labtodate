'use client';

import { useFormStatus } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';

/**
 * Submit button for a server-action <form> that asks for confirmation first
 * and disables itself while the action runs (no double submits).
 */
export function SubmitWithConfirm({
  confirmMessage,
  children,
  disabled,
  ...props
}: Omit<ButtonProps, 'type' | 'onClick'> & { confirmMessage: string }) {
  const { pending } = useFormStatus();
  return (
    <Button
      {...props}
      type="submit"
      disabled={disabled || pending}
      onClick={(e) => {
        if (!window.confirm(confirmMessage)) e.preventDefault();
      }}
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
      {children}
    </Button>
  );
}
