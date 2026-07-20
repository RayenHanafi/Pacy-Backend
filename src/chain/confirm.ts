import { blockfrost } from './provider.js';

/**
 * Waits until a submitted transaction is visible on-chain. Preprod blocks land roughly
 * every 20s, so a burn issued immediately after its mint would otherwise fail to find
 * the UTxO it needs to spend.
 */
export async function waitForTx(txHash: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const provider = blockfrost();

  while (Date.now() < deadline) {
    try {
      await provider.fetchTxInfo(txHash);
      return;
    } catch {
      // Not indexed yet — keep waiting.
    }
    await sleep(5_000);
  }

  throw new Error(`Timed out waiting for tx ${txHash} to confirm`);
}

/**
 * Waits until the address's UTxO set actually contains an output produced by `txHash`.
 *
 * This is the real "safe to build the next transaction" signal. `waitForTx` only proves
 * Blockfrost has indexed the transaction; the address UTxO endpoint updates later, so
 * building on that gap makes the wallet re-select an input it has already spent
 * (`BadInputsUTxO`). Waiting for the change output to appear proves the new state is
 * visible.
 */
export async function waitForWalletSettled(
  address: string,
  txHash: string,
  timeoutMs = 180_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const provider = blockfrost();

  while (Date.now() < deadline) {
    try {
      const utxos = await provider.fetchAddressUTxOs(address);
      if (utxos.some((u) => u.input.txHash === txHash)) return;
    } catch {
      // Transient provider error — retry.
    }
    await sleep(5_000);
  }

  throw new Error(`Timed out waiting for wallet to settle after tx ${txHash}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
