/**
 * Shared transaction helpers for the Plutus (decentralized) path. Mirrors the patterns
 * proven in the onchain/ spikes: fresh UTxO reads, explicit collateral/funding selection,
 * and retry on stale-input errors (Blockfrost's per-address view lags the ledger).
 */
import { MeshTxBuilder, type UTxO } from '@meshsdk/core';
import { blockfrost } from '../provider.js';

export const lovelaceOf = (u: UTxO): bigint =>
  BigInt(u.output.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0');

export function newBuilder(): MeshTxBuilder {
  const p = blockfrost();
  return new MeshTxBuilder({ fetcher: p, submitter: p, verbose: false });
}

/**
 * Smallest adequate pure-ADA UTxO for collateral, and the largest OTHER UTxO to fund fees.
 * Explicit selection keeps a failing tx failing for the RIGHT reason (validator, not
 * coin-selection).
 */
export function isPureAda(u: UTxO): boolean {
  return u.output.amount.length === 1 && u.output.amount[0]?.unit === 'lovelace';
}

export function pickInputs(utxos: UTxO[]): { collateral?: UTxO; funding?: UTxO } {
  // Both collateral AND funding must be PURE ADA. The holding wallet can be cluttered with
  // native-path tokens; dragging those into a Plutus tx makes it huge and fragile.
  const pure = utxos.filter(isPureAda).filter((u) => lovelaceOf(u) >= 5_000_000n);
  const collateral = [...pure].sort((a, b) => Number(lovelaceOf(a) - lovelaceOf(b)))[0];
  const funding = [...pure]
    .filter((u) => u !== collateral)
    .sort((a, b) => Number(lovelaceOf(b) - lovelaceOf(a)))[0];
  return { collateral, funding };
}

/** Retries a build+submit on stale-input errors with freshly fetched UTxOs. */
export async function submitStaleSafe(
  address: string,
  build: (utxos: UTxO[]) => Promise<string>,
  attempts = 8,
): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const utxos = await blockfrost().fetchAddressUTxOs(address);
    try {
      return await build(utxos);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already been included|already spent|BadInputsUTxO|MempoolFailure|inputs/i.test(msg)) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 6_000));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/** Polls until the output created by `txHash` at `address` is visible, and returns it. */
export async function utxoFromTx(address: string, txHash: string, timeoutMs = 120_000): Promise<UTxO> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const utxos = await blockfrost().fetchAddressUTxOs(address);
    const hit = utxos.find((u) => u.input.txHash === txHash);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`output from ${txHash} at ${address} did not appear in time`);
}

/** Polls until `unit` is present at `address`. */
export async function waitForToken(address: string, unit: string, timeoutMs = 120_000): Promise<UTxO> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const utxos = await blockfrost().fetchAddressUTxOs(address);
    const hit = utxos.find((u) => u.output.amount.some((a) => a.unit === unit));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`token ${unit} did not appear at ${address} in time`);
}
