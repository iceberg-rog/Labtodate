import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

// Supplier micro-sites are intentionally disabled: the underlying source
// suppliers are never exposed. Customers transact only through Labtodate.
export default function SupplierPage() {
  notFound();
}
