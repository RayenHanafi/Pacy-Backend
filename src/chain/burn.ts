import { Transaction } from '@meshsdk/core';
import { serviceWallet, serviceAddress } from './wallet.js';
import { buildPolicy, assetUnit } from './policy.js';
import { assetQuantity } from './assets.js';
import { enqueueChainWrite } from './queue.js';
import { AppError, chainError } from '../lib/errors.js';

export type BurnResult = {
  tx_hash: string;
  /** On-chain quantity remaining after this burn. */
  remaining: number;
};

/**
 * Burns one unit of a prescription token — a dispense.
 *
 * The on-chain balance is read INSIDE the serialized queue slot, not before it. By that
 * point any preceding mint has settled, so a dispense issued seconds after the
 * prescription was written sees the real quantity rather than a not-yet-visible zero.
 *
 * The policy script is rebuilt from `expiresAt` and checked against the stored
 * `policyId`: if they disagree, the stored expiry no longer describes the token and we
 * refuse rather than sign something unexpected.
 */
export async function burnPrescriptionUnit(params: {
  policyId: string;
  assetName: string;
  expiresAt: Date | null;
  quantity?: number;
}): Promise<BurnResult> {
  const { policyId, assetName, expiresAt, quantity = 1 } = params;

  return enqueueChainWrite(async () => {
    const wallet = await serviceWallet();
    const address = await serviceAddress();
    const policy = buildPolicy(address, expiresAt);

    if (policy.policyId !== policyId) {
      throw chainError(
        'Policy mismatch — the stored expiry does not reproduce this token’s policy id',
      );
    }

    const unit = assetUnit(policyId, assetName);
    const available = await assetQuantity(address, unit);
    if (available < quantity) {
      throw new AppError(
        'PRESCRIPTION_EXHAUSTED',
        `No units remain on-chain for this prescription (found ${available})`,
      );
    }

    try {
      const tx = new Transaction({ initiator: wallet });
      tx.burnAsset(policy.forgingScript, { unit, quantity: String(quantity) });

      // Past the time-lock the ledger refuses this outright — the expiry guarantee.
      if (policy.expirySlot !== undefined) tx.setTimeToExpire(String(policy.expirySlot));

      const unsigned = await tx.build();
      const signed = await wallet.signTx(unsigned);
      const txHash = await wallet.submitTx(signed);

      return { tx_hash: txHash, remaining: available - quantity };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw chainError(
        `Failed to burn prescription token: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}
