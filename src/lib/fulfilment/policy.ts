import { settingBool, settingEnum, settingInt, settingList, settingString } from '@/lib/settings';
import { DEFAULT_CARRIERS, DEFAULT_RETURN_REASONS } from './settings-defs';
import { parseCarriers, parseReturnReasons, type Carrier, type ReturnReason, type ReturnTypeCode } from './rules';

/**
 * Typed reads of the fulfilment / returns & refunds / payout-lock settings
 * (Admin → Settings → “Fulfilment & delivery”, “Returns & refunds”,
 * “Acquisitions”). Call `await ensureSettingsLoaded()` first.
 */

export function carriers(): Carrier[] {
  const list = parseCarriers(settingString('SHIPPING_CARRIERS'));
  return list.length ? list : parseCarriers(DEFAULT_CARRIERS);
}

export function requireTrackingToShip(): boolean {
  return settingBool('SHIPPING_REQUIRE_TRACKING_TO_SHIP');
}

export function insureByDefault(): boolean {
  return settingBool('SHIPMENT_INSURE_BY_DEFAULT');
}

export function podMaxBytes(): number {
  return settingInt('SHIPMENT_POD_MAX_MB', 8) * 1024 * 1024;
}

export function packingSlipTitle(): string {
  return settingString('PACKING_SLIP_TITLE') || 'Packing slip';
}

export function packingSlipNote(): string {
  return settingString('PACKING_SLIP_NOTE');
}

export function emailProcessingEnabled(): boolean {
  return settingBool('EMAIL_PROCESSING_ENABLED');
}

export function fulfilmentText(key:
  | 'EMAIL_PROCESSING_TEXT' | 'EMAIL_SHIPPED_SUBJECT' | 'EMAIL_SHIPPED_TEXT' | 'EMAIL_SHIPPED_REST_TEXT'
  | 'EMAIL_TRACKING_UPDATED_TEXT' | 'EMAIL_DELIVERED_TEXT'
  | 'RETURN_INSTRUCTIONS_TEXT' | 'RETURN_EMAIL_RECEIVED_TEXT' | 'RETURN_EMAIL_APPROVED_TEXT' | 'RETURN_EMAIL_REJECTED_TEXT'
  | 'RETURN_EMAIL_RECEIVED_GOODS_TEXT'): string {
  return settingString(key);
}

export function returnsEnabled(): boolean {
  return settingBool('RETURNS_ENABLED');
}

export function returnWindowDays(): number {
  return settingInt('RETURN_WINDOW_DAYS', 7);
}

export function warrantyClaimsAfterWindow(): boolean {
  return settingBool('RETURN_WARRANTY_AFTER_WINDOW');
}

export function returnReasons(): ReturnReason[] {
  const list = parseReturnReasons(settingString('RETURN_REASONS'));
  return list.length ? list : parseReturnReasons(DEFAULT_RETURN_REASONS);
}

export function photosRequiredFor(): ReturnTypeCode[] {
  return settingList('RETURN_PHOTOS_REQUIRED_FOR') as ReturnTypeCode[];
}

export function returnMaxFiles(): number {
  return settingInt('RETURN_MAX_FILES', 6);
}

export function returnFileMaxBytes(): number {
  return settingInt('RETURN_FILE_MAX_MB', 8) * 1024 * 1024;
}

export type FreightPaidBy = 'CASE_BY_CASE' | 'BUYER' | 'SELLER';
export function returnFreightPaidBy(): FreightPaidBy {
  return settingEnum<FreightPaidBy>('RETURN_FREIGHT_PAID_BY');
}

export function returnFreightLine(): string {
  const who = returnFreightPaidBy();
  return who === 'BUYER' ? 'Return shipping is at your expense.' : who === 'SELLER' ? 'We pay the return shipping.' : '';
}

/** Where returned goods go: Acquisitions → Receiving warehouse address, else the registered address. */
export function receivingAddress(): string {
  return (settingString('COMPANY_RECEIVING_ADDRESS') || settingString('COMPANY_ADDRESS') || '').trim();
}

export function refundReasons(): string[] {
  return settingList('REFUND_REASONS');
}

export function refundShippedNeedsJustification(): boolean {
  return settingBool('REFUND_SHIPPED_REQUIRES_RETURN_OR_REASON');
}

export function staffCancelReasons(): string[] {
  return settingList('STAFF_CANCEL_REASONS');
}

/** Stock back when a PAID order is canceled before anything shipped. */
export function restockOnPaidCancel(): boolean {
  return settingEnum<'NEVER' | 'ONLY_IF_NOT_SHIPPED'>('AUTO_RESTOCK_ON_REFUND') !== 'NEVER';
}

export type AcqLockStage = 'AWAITING_SHIPPING' | 'IN_TRANSIT' | 'RECEIVED';
export function acqBankLockStage(): AcqLockStage {
  return settingEnum<AcqLockStage>('ACQ_BANK_LOCK_STAGE');
}

export function acqCallbackRequired(): boolean {
  return settingBool('ACQ_BANK_CHANGE_REQUIRE_CALLBACK');
}

export function acqRequireValidIban(): boolean {
  return settingBool('ACQ_REQUIRE_VALID_IBAN');
}

/** One request body (server action) can carry at most this many bytes of files. */
export const UPLOAD_TOTAL_MAX_BYTES = 9 * 1024 * 1024;
