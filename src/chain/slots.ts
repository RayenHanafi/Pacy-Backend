import { resolveSlotNo } from '@meshsdk/core';

const NETWORK = 'preprod';

/**
 * Absolute slot number for a wall-clock time. Used for the native-script time-lock
 * (`before`) and the transaction's `invalidHereafter` bound.
 */
export function slotForDate(date: Date): number {
  return Number(resolveSlotNo(NETWORK, date.getTime()));
}

export function currentSlot(): number {
  return slotForDate(new Date());
}
