import { blockfrost } from './provider.js';

/**
 * Live on-chain quantity of an asset held at an address.
 *
 * Reads the UTxO set directly rather than `wallet.getBalance()`, which can serve a
 * cached view. Always the source of truth for "how many refills are actually left".
 */
export async function assetQuantity(address: string, unit: string): Promise<number> {
  const utxos = await blockfrost().fetchAddressUTxOs(address);
  let total = 0;
  for (const utxo of utxos) {
    for (const amount of utxo.output.amount) {
      if (amount.unit === unit) total += Number(amount.quantity);
    }
  }
  return total;
}

/**
 * Polls until an asset reaches an expected quantity.
 *
 * Blockfrost indexes a transaction (so `fetchTxInfo` succeeds) *before* the address
 * UTxO set reflects it. Waiting only on tx confirmation therefore reads a stale
 * balance — which is exactly what tripped up the first spike run. Anything that mints
 * or burns and then re-reads must wait on the quantity, not just the tx.
 */
export async function waitForAssetQuantity(
  address: string,
  unit: string,
  expected: number,
  timeoutMs = 180_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;

  while (Date.now() < deadline) {
    last = await assetQuantity(address, unit);
    if (last === expected) return last;
    await sleep(5_000);
  }

  throw new Error(
    `Timed out waiting for ${unit} to reach quantity ${expected} (last saw ${last})`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
