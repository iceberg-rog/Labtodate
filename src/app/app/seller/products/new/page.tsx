import { requireSession } from '@/lib/auth-server';
import { ProductForm } from '@/components/seller/ProductForm';
import { createProduct } from '../actions';
import { sellerFormOptions } from '../form-options';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'New listing' };

export default async function NewProductPage() {
  const session = await requireSession({ roles: ['SELLER', 'ADMIN'], redirectTo: '/app/seller/products/new' });
  const options = await sellerFormOptions();
  const supplier = (session.user as { role?: string }).role === 'SELLER';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">New listing</h1>
        <p className="text-muted-foreground mt-1">Tell buyers what you&apos;re selling. Submitted for admin review before going live.</p>
      </div>
      <ProductForm options={options} supplierPrice={supplier} onSubmit={createProduct} submitLabel="Submit for review" />
    </div>
  );
}
