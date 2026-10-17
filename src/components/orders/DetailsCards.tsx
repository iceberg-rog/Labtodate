'use client';

import type { ComponentProps } from 'react';
import { buyerSaveOrderDetails } from '@/app/app/orders/[orderNumber]/payment/actions';
import { adminSetOrderDetails } from '@/app/admin/quote-payment-actions';
import { OrderDetailsCard } from './OrderDetailsCard';

type Base = Omit<ComponentProps<typeof OrderDetailsCard>, 'save'>;

/** Payment page: the buyer saves their own details (no receipt needed). */
export function BuyerDetailsCard({ orderNumber, ...p }: Base & { orderNumber: string }) {
  return <OrderDetailsCard {...p} save={(details, saveProfile) => buyerSaveOrderDetails({ orderNumber, details, saveProfile })} />;
}

/** Admin order page: staff enter the details the buyer sent by email / phone. */
export function AdminDetailsCard({ orderId, ...p }: Base & { orderId: string }) {
  return <OrderDetailsCard {...p} showSaveProfile={false} save={(details) => adminSetOrderDetails({ orderId, details })} />;
}
