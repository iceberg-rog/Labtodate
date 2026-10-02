'use client';

import { useState } from 'react';

/**
 * <details> whose initial open state is decided once, on mount. A
 * server-computed `open` (e.g. "open while the shipping address is missing")
 * flips after the save's router.refresh() and collapsed the section, hiding
 * the form's own "saved" message. Opening/closing it by hand works as usual.
 */
export function StickyDetails({
  defaultOpen,
  className,
  children,
}: {
  defaultOpen: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [open] = useState(defaultOpen);
  return (
    <details className={className} open={open}>
      {children}
    </details>
  );
}
