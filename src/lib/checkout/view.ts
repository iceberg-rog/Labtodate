/**
 * What the checkout page shows (serialisable, client-safe). Built on the
 * server from a CheckoutComputation; the browser never computes a price.
 */
import type { PaymentMethodCode } from './input';
import type { PriceDisplayMode } from '@/lib/pricing/display';

export interface CheckoutLineView {
  productId: string;
  slug: string;
  title: string;
  brand: string | null;
  qty: number;
  unitNetCents: number;
  lineNetCents: number;
  vatRateBp: number;
  taxCents: number;
  /** The condition label and the warranty this unit is sold under (as the order line will record them). */
  conditionLabel: string | null;
  warranty: string | null;
}

export interface CheckoutQuoteView {
  /** False while something makes ordering impossible (refusal). */
  canOrder: boolean;
  refusal: { code: string; message: string } | null;
  currency: string;
  displayMode: PriceDisplayMode;
  labels: { excl: string; incl: string };
  lines: CheckoutLineView[];
  goodsCents: number;
  shipping: { status: 'QUOTED' | 'TO_BE_CONFIRMED'; cents: number; zone: string | null; leadTime: string | null; note: string };
  vat: {
    treatment: string;
    label: string;
    rateBp: number | null;
    review: boolean;
    rows: Array<{ rateBp: number; baseCents: number; taxCents: number }>;
    legalText: string | null;
    /** One sentence for the buyer about why this VAT applies. */
    explanation: string;
  };
  vatId: null | {
    input: string;
    status: 'VALID' | 'INVALID' | 'UNAVAILABLE' | 'NOT_CHECKED';
    name: string | null;
    consultationNumber: string | null;
    message: string;
  };
  country: { code: string; name: string; mode: 'ALLOW' | 'REVIEW' | 'BLOCK' };
  holds: Array<{ code: string; message: string }>;
  taxCents: number;
  totalCents: number;
  /** Hints that help the buyer (e.g. add a VAT ID for 0% intra-EU). */
  hints: string[];
  paymentMethods: Array<{ code: PaymentMethodCode; label: string; note: string }>;
  /** Order-button texts (Settings → Checkout & customers / Sales channel). */
  submitLabels: { bank: string; card: string; hold: string; consumer: string };
}

export type PlaceOrderState =
  | { status: 'idle' }
  | {
      status: 'error';
      message: string;
      fieldErrors: Record<string, string>;
      quote: CheckoutQuoteView | null;
      /** Totals changed since the buyer saw them — show the new ones before re-submitting. */
      changed?: boolean;
    };

export const PAYMENT_METHOD_LABEL: Record<PaymentMethodCode, string> = {
  BANK_TRANSFER: 'Bank transfer',
  STRIPE_CARD: 'Card (Stripe)',
};
