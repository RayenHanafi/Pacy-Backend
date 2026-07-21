import { Transaction } from '@meshsdk/core';
import { serviceWallet, serviceAddress } from './wallet.js';
import { buildPolicy, assetNameFor, assetUnit } from './policy.js';
import { enqueueChainWrite } from './queue.js';
import { chainError } from '../lib/errors.js';

export type MintResult = {
  tx_hash: string;
  policy_id: string;
  asset_name: string;
  unit: string;
  expiry_slot: number | null;
};

/**
 * Mints the prescription token: one unit per permitted fill.
 *
 * The ledger cannot burn more units than exist, so over-dispensing is impossible by
 * construction — no smart contract required. With an expiry, the policy carries a
 * `before(slot)` time-lock and the chain refuses any burn past it.
 *
 * Returns as soon as the node accepts the transaction; it is NOT yet confirmed in a
 * block. Callers that need to read the resulting balance must wait (see
 * `waitForAssetQuantity`), because Blockfrost's UTxO view lags tx submission.
 */
/**
 * Cardano rejects any metadata string longer than 64 bytes, and a base64 P-256 signature
 * is 88 characters. Splitting it into an array of chunks is the standard way round this;
 * a reader concatenates them back.
 */
function chunk64(value: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < value.length; i += 64) parts.push(value.slice(i, i + 64));
  return parts;
}

export async function mintPrescriptionToken(params: {
  prescriptionId: string;
  quantity: number;
  contentHash: string;
  /** The prescribing doctor's signature over the content — proof a human authorised this. */
  doctorSignature: string;
  expiresAt: Date | null;
}): Promise<MintResult> {
  const { prescriptionId, quantity, contentHash, doctorSignature, expiresAt } = params;

  // Serialized: concurrent builds would select the same unconfirmed inputs.
  return enqueueChainWrite(async () => {
    const wallet = await serviceWallet();
    const address = await serviceAddress();
    const policy = buildPolicy(address, expiresAt);
    const assetName = assetNameFor(prescriptionId);

    try {
      const tx = new Transaction({ initiator: wallet });
      tx.mintAsset(policy.forgingScript, {
        assetName,
        assetQuantity: String(quantity),
        recipient: address,
      });

      // Content hash and the doctor's signature over it — never drug details, never
      // anything identifying a patient. `sig` makes the authorisation publicly checkable:
      // anyone can verify it against the doctor's enrolled public key, without us.
      tx.setMetadata(674, { hash: contentHash, sig: chunk64(doctorSignature), v: 2 });

      // A transaction may not outlive the policy's own time-lock.
      if (policy.expirySlot !== undefined) tx.setTimeToExpire(String(policy.expirySlot));

      const unsigned = await tx.build();
      const signed = await wallet.signTx(unsigned);
      const txHash = await wallet.submitTx(signed);

      return {
        tx_hash: txHash,
        policy_id: policy.policyId,
        asset_name: assetName,
        unit: assetUnit(policy.policyId, assetName),
        expiry_slot: policy.expirySlot ?? null,
      };
    } catch (err) {
      throw chainError(
        `Failed to mint prescription token: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}
