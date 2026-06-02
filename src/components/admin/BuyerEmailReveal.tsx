'use client';

import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/**
 * Renders a buyer email with an eye toggle to mask/reveal in-place.
 *
 * `initialReveal` defaults to `true` for admin surfaces where ops want the
 * full address visible without clicking; pass `false` on screen-share-prone
 * surfaces (demo mode, public-facing operator views) to mask first.
 */
export function BuyerEmailReveal({
  email,
  className,
  initialReveal = true,
}: {
  email: string;
  className?: string;
  initialReveal?: boolean;
}) {
  const [shown, setShown] = useState(initialReveal);
  const [_, dom] = email.split('@');
  const head = email.length <= 2 ? email[0] : email.slice(0, 2);
  const masked = `${head}${'•'.repeat(Math.max(2, Math.min(6, email.length - 2)))}@${dom ?? ''}`;
  return (
    <span className={`inline-flex items-center gap-1 ${className ?? ''}`}>
      <span className="tabular-nums">{shown ? email : masked}</span>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setShown((s) => !s);
        }}
        className="opacity-50 hover:opacity-100"
        title={shown ? 'Hide email' : 'Reveal email'}
        aria-label={shown ? 'Hide email' : 'Reveal email'}
      >
        {shown ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
      </button>
    </span>
  );
}
