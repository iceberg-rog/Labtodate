'use client';

import { Button, type ButtonProps } from '@/components/ui/button';

/**
 * Submit button for a server-rendered `<form action={…}>` that asks for a
 * browser confirm() first — drop-in for one-click destructive actions
 * (delete a case study / testimonial / facility / category …).
 */
export function ConfirmSubmitButton({
  message,
  onClick,
  ...props
}: Omit<ButtonProps, 'type'> & { message: string }) {
  return (
    <Button
      {...props}
      type="submit"
      onClick={(e) => {
        if (!window.confirm(message)) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    />
  );
}
