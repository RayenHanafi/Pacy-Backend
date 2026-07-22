/**
 * The backend's holding + admin wallet for the Plutus path.
 *
 * Deliberately the SAME service wallet the native path already uses: it holds the minted
 * prescription tokens, pays every transaction fee, and is the settings-datum `admin`
 * (so it may update the allow-list). What it CANNOT do is mint or burn a prescription on
 * its own — the on-chain policy additionally requires an enrolled doctor's (mint) or
 * pharmacy's (burn) signature, and those keys live only in users' browsers.
 */
import { deserializeAddress } from '@meshsdk/core';
import { serviceWallet, serviceAddress } from '../wallet.js';
import { blockfrost } from '../provider.js';
import { newBuilder, lovelaceOf, isPureAda } from './txHelpers.js';

let cachedKeyHash: string | null = null;

export { serviceWallet as holdingWallet, serviceAddress as holdingAddress };

/** Payment key hash of the holding/admin wallet — the settings-datum admin. */
export async function holdingKeyHash(): Promise<string> {
  if (cachedKeyHash) return cachedKeyHash;
  const address = await serviceAddress();
  cachedKeyHash = deserializeAddress(address).pubKeyHash;
  return cachedKeyHash;
}

/**
 * Ensures the holding wallet has at least two SUBSTANTIAL UTxOs. Every Plutus transaction
 * needs one for collateral plus at least one more to spend; a wallet holding a single big
 * UTxO cannot build one. Splits by paying itself. Safe to call before any chain write.
 */
export async function ensureHoldingUtxos(need = 10, min = 10_000_000n): Promise<void> {
  const p = blockfrost();
  const address = await serviceAddress();
  let utxos = await p.fetchAddressUTxOs(address);
  const clean = () => utxos.filter((u) => isPureAda(u) && lovelaceOf(u) >= min).length;
  if (clean() >= need) return;

  const shortfall = need - clean();
  const wallet = await serviceWallet();
  let b = newBuilder();
  for (let i = 0; i < shortfall; i++) b = b.txOut(address, [{ unit: 'lovelace', quantity: String(min) }]);
  // Fund the buffer from the CLUTTERED UTxOs only, preserving the clean ones we already
  // have. One generous split up front; downstream ops reuse the change (>= 5 ADA still
  // qualifies in pickInputs), so no re-splitting is needed mid-flow.
  const dirty = utxos.filter((u) => !(isPureAda(u) && lovelaceOf(u) >= min));
  const unsigned = await b.changeAddress(address).selectUtxosFrom(dirty).complete();
  const signed = await wallet.signTx(unsigned, true);
  await wallet.submitTx(signed);

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    utxos = await p.fetchAddressUTxOs(address);
    if (clean() >= need) return;
  }
  throw new Error('holding wallet did not reach enough clean UTxOs in time');
}
