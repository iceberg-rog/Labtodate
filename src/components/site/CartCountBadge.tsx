'use client';

import { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * Small count bubble on the header cart icon. Re-fetched on every navigation
 * (add-to-cart, remove and checkout all end in a redirect), so it stays in step
 * with the cart without a global store. Renders nothing for an empty cart.
 */
export function CartCountBadge() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [count, setCount] = useState(0);

  useEffect(() => {
    let alive = true;
    fetch('/api/cart/count', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { count: 0 }))
      .then((d: { count?: number }) => {
        if (alive) setCount(typeof d.count === 'number' ? d.count : 0);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [pathname, searchParams]);

  if (count <= 0) return null;
  return (
    <span
      aria-label={`${count} item${count === 1 ? '' : 's'} in cart`}
      className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold leading-[18px] text-center"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
