'use client';

import { Button } from '@/components/ui/button';

/**
 * Submit button for the listing's delete form that asks first — one mis-click
 * used to destroy a listing with no undo. Listings with past orders are
 * archived by the server instead, and the prompt says so.
 */
export function DeleteListingButton({ title, hasOrders }: { title: string; hasOrders: boolean }) {
  return (
    <Button
      type="submit"
      variant="ghost"
      size="sm"
      className="rounded-full font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 hover:text-red-700 dark:hover:text-red-300"
      onClick={(e) => {
        const msg = hasOrders
          ? `“${title}” has past orders, so it will be archived (hidden from buyers) instead of deleted. Continue?`
          : `Delete “${title}”? This cannot be undone.`;
        if (!window.confirm(msg)) e.preventDefault();
      }}
    >
      Delete
    </Button>
  );
}
