'use client';

import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Submit button for the product delete form that asks first. A product with
 * order history is archived by the server instead of deleted, and the prompt
 * says so up front.
 */
export function DeleteProductButton({ title, hasOrders }: { title: string; hasOrders: boolean }) {
  return (
    <Button
      type="submit"
      variant="outline"
      size="sm"
      className="rounded-full text-red-700 dark:text-red-300 border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-950/40"
      onClick={(e) => {
        const msg = hasOrders
          ? `“${title}” has order history, so it will be archived (hidden from the marketplace) instead of deleted. Continue?`
          : `Delete “${title}” permanently? This cannot be undone.`;
        if (!window.confirm(msg)) e.preventDefault();
      }}
    >
      <Trash2 className="h-3.5 w-3.5" /> {hasOrders ? 'Archive' : 'Delete'}
    </Button>
  );
}
