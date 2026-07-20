import { MeshWallet } from '@meshsdk/core';
import { blockfrost } from './provider.js';
import { requireConfig } from '../config.js';

let cachedAddress: string | null = null;

/**
 * The custodial service wallet. Signs every mint and burn on behalf of doctors and
 * pharmacies (see PROJECT.md §12 — non-custodial signing is an explicit scope cut).
 *
 * Deliberately NOT cached. A MeshWallet snapshots the UTxO set it was built with, so a
 * reused instance will happily select an input that an earlier transaction already
 * spent — which the ledger rejects with `BadInputsUTxO`. Key derivation costs a few
 * milliseconds; a wrong input costs a failed prescription.
 */
export async function serviceWallet(): Promise<MeshWallet> {
  return initWallet();
}

async function initWallet(): Promise<MeshWallet> {
  const provider = blockfrost();
  const words = requireConfig('SERVICE_WALLET_MNEMONIC').trim().split(/\s+/);

  const wallet = new MeshWallet({
    networkId: 0, // 0 = testnet (preprod)
    fetcher: provider,
    submitter: provider,
    key: { type: 'mnemonic', words },
  });

  // Mesh >=1.8 requires an explicit init before key derivation.
  const maybeInit = (wallet as unknown as { init?: () => Promise<void> }).init;
  if (typeof maybeInit === 'function') await maybeInit.call(wallet);

  return wallet;
}

/** The address is deterministic from the mnemonic, so it is safe to cache. */
export async function serviceAddress(): Promise<string> {
  if (cachedAddress === null) {
    const wallet = await serviceWallet();
    cachedAddress = await wallet.getChangeAddress();
  }
  return cachedAddress;
}
