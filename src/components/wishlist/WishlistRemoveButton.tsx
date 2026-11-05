'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, X } from 'lucide-react';
import { removeFromWishlist } from '@/lib/wishlist/actions';

/** "Remove" under a saved item on the wishlist page. */
export function WishlistRemoveButton({ slug, title }: { slug: string; title: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await removeFromWishlist(slug);
          router.refresh();
        })
      }
      aria-label={`Remove ${title} from wishlist`}
      className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground hover:bg-foreground/5 disabled:opacity-60"
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <X className="h-3.5 w-3.5" aria-hidden />}
      Remove from wishlist
    </button>
  );
}
