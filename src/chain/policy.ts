import {
  ForgeScript,
  deserializeAddress,
  resolveNativeScriptHash,
  stringToHex,
  type NativeScript,
} from '@meshsdk/core';
import { slotForDate } from './slots.js';

export type PrescriptionPolicy = {
  script: NativeScript;
  /** CBOR forging script handed to the transaction builder. */
  forgingScript: string;
  policyId: string;
  /** Present only when the prescription has an expiry. */
  expirySlot?: number;
};

/**
 * Builds the native minting policy for one prescription.
 *
 * - No expiry  -> `sig(serviceKey)` alone.
 * - With expiry -> `all[ sig(serviceKey), before(expirySlot) ]`. After that slot the
 *   ledger will not validate ANY transaction under this policy, so a burn (dispense)
 *   becomes impossible by construction. That is the expiry guarantee — enforced by the
 *   chain, not by our database.
 *
 * Note a native script cannot distinguish minting from burning, so "only the pharmacy
 * may burn" is enforced by the backend authorization layer, not here (PROJECT.md §13).
 */
export function buildPolicy(
  serviceAddress: string,
  expiresAt: Date | null,
): PrescriptionPolicy {
  const { pubKeyHash } = deserializeAddress(serviceAddress);
  const sig: NativeScript = { type: 'sig', keyHash: pubKeyHash };

  if (expiresAt === null) {
    return {
      script: sig,
      forgingScript: ForgeScript.fromNativeScript(sig),
      policyId: resolveNativeScriptHash(sig),
    };
  }

  const expirySlot = slotForDate(expiresAt);
  const script: NativeScript = {
    type: 'all',
    scripts: [sig, { type: 'before', slot: String(expirySlot) }],
  };

  return {
    script,
    forgingScript: ForgeScript.fromNativeScript(script),
    policyId: resolveNativeScriptHash(script),
    expirySlot,
  };
}

/**
 * Asset name for a prescription: the UUID with dashes stripped — exactly 32 chars,
 * the maximum Cardano allows. Every prescription is therefore a globally distinct
 * asset, even when two share a policy id (which happens for no-expiry prescriptions).
 *
 * Returned as a PLAIN string because Mesh hex-encodes asset names itself; use
 * `assetUnit()` when you need the on-chain unit.
 */
export function assetNameFor(prescriptionId: string): string {
  return prescriptionId.replace(/-/g, '');
}

/** On-chain asset identifier: policy id concatenated with the hex-encoded asset name. */
export function assetUnit(policyId: string, assetName: string): string {
  return policyId + stringToHex(assetName);
}
