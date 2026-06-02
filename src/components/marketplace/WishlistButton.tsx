'use client';

import { useState, useTransition } from 'react';
import { Heart, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toggleWishlist } from '@/lib/wishlist/actions';

export function WishlistButton({
  productSlug,
  initiallySaved,
}: {
  productSlug: string;
  initiallySaved: boolean;
}) {
  const [saved, setSaved] = useState(initiallySaved);
  const [pending, startTransition] = useTransition();

  function toggle() {
    startTransition(async () => {
      try {
        setSaved((s) => !s);
        await toggleWishlist(productSlug);
      } catch {
        setSaved((s) => !s); // revert
      }
    });
  }

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={toggle}
      disabled={pending}
      className="rounded-2xl font-semibold w-full"
      aria-pressed={saved}
    >
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Heart className={`h-4 w-4 ${saved ? 'fill-accent text-accent' : ''}`} />
      )}
      {saved ? 'Saved to wishlist' : 'Save to wishlist'}
    </Button>
  );
}
