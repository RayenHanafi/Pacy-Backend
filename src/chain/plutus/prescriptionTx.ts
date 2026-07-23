/**
 * Builds the UNSIGNED mint/burn transactions for the decentralized path, and co-signs +
 * submits the version the user signed in their browser.
 *
 * The holding wallet supplies every input, the collateral, and the change, and holds the
 * minted token — so users never need tADA. The user's key appears only as a REQUIRED
 * SIGNER, which the on-chain policy demands (a doctor for a mint, a pharmacy for a burn).
 * Result: the backend cannot mint or burn a prescription without the user's signature,
 * yet the user carries none of the on-chain plumbing.
 *
 * Flow: backend `buildMintUnsigned` -> frontend `wallet.signTx(tx, true)` (user witness)
 *       -> backend `coSignAndSubmit` (holding witness) -> submitted.
 */
import { mConStr0 } from '@meshsdk/core';
import { plutusContracts } from './config.js';
import { holdingWallet, holdingAddress } from './backendWallet.js';
import { currentSettingsUtxo } from './settings.js';
import { newBuilder, pickInputs, waitForToken } from './txHelpers.js';
import { slotForDate } from '../slots.js';
import { blockfrost } from '../provider.js';
import { chainError, AppError } from '../../lib/errors.js';

/** Expiry as POSIX milliseconds for the on-chain datum; 0 means "never expires". */
const expiryDatum = (expiresAt: Date | null): number => (expiresAt ? expiresAt.getTime() : 0);

/** Builds the unsigned mint tx. The doctor's key hash is the required (policy) signer. */
export async function buildMintUnsigned(params: {
  doctorKeyHash: string;
  assetNameHex: string;
  quantity: number;
  contentHash: string;
  expiresAt: Date | null;
}): Promise<{ unsignedTx: string }> {
  const { doctorKeyHash, assetNameHex, quantity, contentHash, expiresAt } = params;
  const c = plutusContracts();
  const holding = await holdingAddress();
  const settings = await currentSettingsUtxo();
  const unit = c.policyId + assetNameHex;

  const utxos = await blockfrost().fetchAddressUTxOs(holding);
  const { collateral, funding } = pickInputs(utxos);
  if (!collateral || !funding) throw chainError('Holding wallet lacks two pure-ADA UTxOs (collateral + funding)');

  try {
    // Explicit funding input (pure ADA) — no auto-selection, so the tx stays small and
    // never drags in the holding wallet's unrelated native-path tokens. The token output
    // carries the expiry as an inline datum, which the burn later enforces on-chain.
    const unsignedTx = await newBuilder()
      .mintPlutusScriptV3()
      .mint(String(quantity), c.policyId, assetNameHex)
      .mintingScript(c.policyCbor)
      .mintRedeemerValue(mConStr0([]))
      .readOnlyTxInReference(settings.input.txHash, settings.input.outputIndex)
      .txIn(funding.input.txHash, funding.input.outputIndex, funding.output.amount, funding.output.address)
      .txOut(holding, [
        { unit: 'lovelace', quantity: '2500000' },
        { unit, quantity: String(quantity) },
      ])
      .txOutInlineDatumValue(expiryDatum(expiresAt))
      .txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount, collateral.output.address)
      .requiredSignerHash(doctorKeyHash) // the policy checks this against the enrolled doctors
      .metadataValue(674, { hash: contentHash })
      .changeAddress(holding)
      .complete();
    return { unsignedTx };
  } catch (err) {
    throw chainError(`Failed to build mint tx: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Builds the unsigned burn tx. The pharmacy's key hash is the required (policy) signer. */
export async function buildBurnUnsigned(params: {
  pharmacyKeyHash: string;
  assetNameHex: string;
  quantity?: number;
  /** The prescription's expiry — bounds the tx so the policy's on-chain expiry check passes. */
  expiresAt: Date | null;
}): Promise<{ unsignedTx: string }> {
  const { pharmacyKeyHash, assetNameHex, quantity = 1, expiresAt } = params;
  const c = plutusContracts();
  const holding = await holdingAddress();
  const settings = await currentSettingsUtxo();
  const unit = c.policyId + assetNameHex;

  // The token lives in the holding wallet; give the mint a moment to settle if just made.
  await waitForToken(holding, unit).catch(() => {});
  const utxos = await blockfrost().fetchAddressUTxOs(holding);
  const tokenUtxo = utxos.find((u) => u.output.amount.some((a) => a.unit === unit));
  if (!tokenUtxo) throw chainError('Token not found in holding wallet — mint may not have settled');
  const { collateral, funding } = pickInputs(utxos.filter((u) => u !== tokenUtxo));
  if (!collateral || !funding) throw chainError('Holding wallet lacks spendable UTxOs for the burn');

  // How many units remain after this burn. The leftover must be sent back to the holding
  // wallet WITH the expiry datum re-attached — otherwise Mesh returns it as a plain change
  // output with no datum, and the next dispense's on-chain expiry check has nothing to read.
  const held = BigInt(tokenUtxo.output.amount.find((a) => a.unit === unit)?.quantity ?? '0');
  const remaining = held - BigInt(quantity);

  try {
    let builder = newBuilder()
      .mintPlutusScriptV3()
      .mint('-' + String(quantity), c.policyId, assetNameHex)
      .mintingScript(c.policyCbor)
      .mintRedeemerValue(mConStr0([]))
      .readOnlyTxInReference(settings.input.txHash, settings.input.outputIndex)
      .txIn(tokenUtxo.input.txHash, tokenUtxo.input.outputIndex, tokenUtxo.output.amount, tokenUtxo.output.address)
      .txIn(funding.input.txHash, funding.input.outputIndex, funding.output.amount, funding.output.address)
      .txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount, collateral.output.address)
      .requiredSignerHash(pharmacyKeyHash); // the policy checks this against the enrolled pharmacies

    if (remaining > 0n) {
      builder = builder
        .txOut(holding, [
          { unit: 'lovelace', quantity: '2500000' },
          { unit, quantity: remaining.toString() },
        ])
        .txOutInlineDatumValue(expiryDatum(expiresAt)); // carry the expiry forward
    }

    builder = builder.changeAddress(holding);

    // Bound the tx to end at or before expiry, so the policy's on-chain expiry check passes
    // (and the ledger itself rejects a burn submitted after expiry).
    if (expiresAt) builder = builder.invalidHereafter(slotForDate(expiresAt));

    const unsignedTx = await builder.complete();
    return { unsignedTx };
  } catch (err) {
    throw chainError(`Failed to build burn tx: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Adds the holding wallet's signature to the user-signed tx and submits it. The user's
 * witness must already be present (they signed in the browser); this contributes the
 * holding-wallet witness needed to spend its inputs, then broadcasts.
 */
export async function coSignAndSubmit(userSignedTx: string): Promise<string> {
  try {
    const wallet = await holdingWallet();
    const fullySigned = await wallet.signTx(userSignedTx, true);
    return await wallet.submitTx(fullySigned);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw chainError(`Failed to co-sign/submit: ${err instanceof Error ? err.message : String(err)}`);
  }
}
