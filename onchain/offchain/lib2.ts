/**
 * Checkpoint 2 off-chain library — the settings-UTxO (datum allow-list) design.
 *
 * Four actors now:
 *   - admin    : the cold key that owns the settings UTxO and may update the allow-list.
 *   - doctorA  : enrolled from the start.
 *   - doctorB  : NOT enrolled at first — added later by an on-chain datum update.
 *   - pharmacy : enrolled to burn.
 *
 * doctorA and pharmacy are reused from Checkpoint 1's funded demo wallets; admin and
 * doctorB are generated here and funded from doctorA. All throwaway preprod wallets.
 */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MeshWallet,
  applyParamsToScript,
  deserializeAddress,
  mConStr0,
  resolveScriptHash,
  serializePlutusScript,
  type UTxO,
} from '@meshsdk/core';
import { loadDemoWallets, provider, type DemoWallet } from './lib.js';

const here = dirname(fileURLToPath(import.meta.url));
const WALLET_FILE = join(here, '..', '.settings-wallets.json');
const BLUEPRINT = join(here, '..', 'plutus.json');

export const lovelaceOf = (u: UTxO): bigint =>
  BigInt(u.output.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0');

function validator(title: string): { compiledCode: string; hash: string } {
  const b = JSON.parse(readFileSync(BLUEPRINT, 'utf8'));
  const v = b.validators.find((x: { title: string }) => x.title === title);
  if (!v) throw new Error(`Validator ${title} not found — run "aiken build"`);
  return v;
}

async function walletFrom(role: string, mnemonic: string): Promise<DemoWallet> {
  const p = provider();
  const wallet = new MeshWallet({
    networkId: 0,
    fetcher: p,
    submitter: p,
    key: { type: 'mnemonic', words: mnemonic.split(' ') },
  });
  const maybeInit = (wallet as unknown as { init?: () => Promise<void> }).init;
  if (typeof maybeInit === 'function') await maybeInit.call(wallet);
  const address = await wallet.getChangeAddress();
  const { pubKeyHash } = deserializeAddress(address);
  return { role: role as DemoWallet['role'], wallet, address, keyHash: pubKeyHash };
}

export type SettingsWallets = {
  admin: DemoWallet;
  doctorA: DemoWallet;
  doctorB: DemoWallet;
  pharmacy: DemoWallet;
};

export async function loadSettingsWallets(): Promise<SettingsWallets> {
  let store: { admin: string; doctorB: string };
  if (existsSync(WALLET_FILE)) {
    store = JSON.parse(readFileSync(WALLET_FILE, 'utf8'));
  } else {
    store = {
      admin: (MeshWallet.brew() as string[]).join(' '),
      doctorB: (MeshWallet.brew() as string[]).join(' '),
    };
    writeFileSync(WALLET_FILE, JSON.stringify(store, null, 2));
    console.log(`Generated admin + doctorB → ${WALLET_FILE} (git-ignored)`);
  }

  const base = await loadDemoWallets(); // doctorA + pharmacy (funded in Checkpoint 1)
  const [admin, doctorB] = await Promise.all([
    walletFrom('admin', store.admin),
    walletFrom('doctorB', store.doctorB),
  ]);
  return { admin, doctorA: base.doctor, doctorB, pharmacy: base.pharmacy };
}

export type Contracts = {
  settingsCbor: string;
  settingsHash: string;
  settingsAddress: string;
  policyCbor: string;
  policyId: string;
};

/** Builds both scripts and binds the policy to the settings script hash. */
export function buildContracts(): Contracts {
  const settings = validator('settings.settings.spend');
  const gated = validator('prescription_gated.prescription_gated.mint');

  // Apply empty params to get the canonically double-CBOR-wrapped script. The raw
  // `compiledCode` from plutus.json is single-encoded; a spend witness needs the wrapped
  // form or the ledger reports MalformedScriptWitnesses. The hash/address are unchanged.
  const settingsCbor = applyParamsToScript(settings.compiledCode, [], 'JSON');
  const settingsHash = resolveScriptHash(settingsCbor, 'V3');
  const settingsAddress = serializePlutusScript(
    { code: settingsCbor, version: 'V3' },
    undefined,
    0, // preprod
  ).address;

  const policyCbor = applyParamsToScript(gated.compiledCode, [{ bytes: settingsHash }], 'JSON');
  const policyId = resolveScriptHash(policyCbor, 'V3');

  return { settingsCbor, settingsHash, settingsAddress, policyCbor, policyId };
}

/** The inline datum for the settings UTxO: Settings{ admin, doctors, pharmacies }. */
export function settingsDatum(adminHash: string, doctors: string[], pharmacies: string[]) {
  return mConStr0([adminHash, doctors, pharmacies]);
}
