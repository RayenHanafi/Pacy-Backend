/**
 * Shared helpers for the on-chain spike.
 *
 * Two throwaway PREPROD demo wallets (a "doctor" and a "pharmacy") stand in for the
 * real registered practitioners. Their mnemonics are generated once and cached in a
 * git-ignored file so the same wallets — and therefore the same policy id — persist
 * across runs. These are test wallets holding only faucet tADA; never reuse them for
 * anything real.
 *
 * The doctor/pharmacy key hashes are applied as parameters to the compiled validator,
 * which is what binds THIS policy id to THESE two keys. Change a key and the policy id
 * changes — the on-chain identity is derived from the credentials, not asserted by us.
 */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MeshWallet,
  BlockfrostProvider,
  applyParamsToScript,
  resolveScriptHash,
  deserializeAddress,
} from '@meshsdk/core';

const here = dirname(fileURLToPath(import.meta.url));
const WALLET_FILE = join(here, '..', '.demo-wallets.json');
const BLUEPRINT = join(here, '..', 'plutus.json');
const VALIDATOR_TITLE = 'prescription.prescription.mint';

export function provider(): BlockfrostProvider {
  const key = process.env.BLOCKFROST_PROJECT_ID;
  if (!key) throw new Error('BLOCKFROST_PROJECT_ID is not set (.env)');
  return new BlockfrostProvider(key);
}

export type DemoWallet = {
  role: 'doctor' | 'pharmacy';
  wallet: MeshWallet;
  address: string;
  keyHash: string;
};

async function walletFrom(role: 'doctor' | 'pharmacy', mnemonic: string): Promise<DemoWallet> {
  const p = provider();
  const wallet = new MeshWallet({
    networkId: 0, // preprod
    fetcher: p,
    submitter: p,
    key: { type: 'mnemonic', words: mnemonic.split(' ') },
  });
  const maybeInit = (wallet as unknown as { init?: () => Promise<void> }).init;
  if (typeof maybeInit === 'function') await maybeInit.call(wallet);

  const address = await wallet.getChangeAddress();
  const { pubKeyHash } = deserializeAddress(address);
  return { role, wallet, address, keyHash: pubKeyHash };
}

/** Loads the two demo wallets, generating and caching them on first use. */
export async function loadDemoWallets(): Promise<{ doctor: DemoWallet; pharmacy: DemoWallet }> {
  let store: { doctor: string; pharmacy: string };

  if (existsSync(WALLET_FILE)) {
    store = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
  } else {
    store = {
      doctor: (MeshWallet.brew() as string[]).join(' '),
      pharmacy: (MeshWallet.brew() as string[]).join(' '),
    };
    writeFileSync(WALLET_FILE, JSON.stringify(store, null, 2));
    console.log(`Generated two demo wallets → ${WALLET_FILE} (git-ignored)`);
  }

  const [doctor, pharmacy] = await Promise.all([
    walletFrom('doctor', store.doctor),
    walletFrom('pharmacy', store.pharmacy),
  ]);
  return { doctor, pharmacy };
}

export type Policy = {
  /** Parameterised script CBOR, ready for the tx builder. */
  scriptCbor: string;
  /** Policy id = script hash — derived from the two key hashes. */
  policyId: string;
};

/** Binds the compiled validator to a specific doctor + pharmacy key hash. */
export function buildPolicy(doctorKeyHash: string, pharmacyKeyHash: string): Policy {
  const blueprint = JSON.parse(readFileSync(BLUEPRINT, 'utf8'));
  const validator = blueprint.validators.find(
    (v: { title: string }) => v.title === VALIDATOR_TITLE,
  );
  if (!validator) throw new Error(`Validator ${VALIDATOR_TITLE} not found — run "aiken build"`);

  // Params are Plutus ByteArrays, expressed as JSON data: { bytes: "<hex>" }.
  const scriptCbor = applyParamsToScript(
    validator.compiledCode,
    [{ bytes: doctorKeyHash }, { bytes: pharmacyKeyHash }],
    'JSON',
  );
  const policyId = resolveScriptHash(scriptCbor, 'V3');
  return { scriptCbor, policyId };
}
