/**
 * Plutus (Checkpoint 2) contract configuration for the DECENTRALIZED path.
 *
 * Builds the two Aiken scripts from the committed blueprint (onchain/plutus.json):
 *   - the settings validator (holds the allow-list datum; admin-only to update)
 *   - the prescription_gated minting policy (mint/burn gated by the referenced allow-list)
 *
 * The allowed doctor/pharmacy KEY HASHES live on-chain in the settings datum; a mint is
 * valid only if an enrolled doctor signed, a burn only if an enrolled pharmacy signed.
 * The backend never holds those keys — it only supplies fees and the holding UTxO.
 *
 * This module is inert unless CHAIN_MODE=plutus; the native-script path is untouched.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyParamsToScript,
  mConStr0,
  resolveScriptHash,
  serializePlutusScript,
} from '@meshsdk/core';

const here = dirname(fileURLToPath(import.meta.url));
// src/chain/plutus -> project root -> onchain/plutus.json (same depth in dist/).
const BLUEPRINT = join(here, '..', '..', '..', 'onchain', 'plutus.json');

function validator(title: string): { compiledCode: string } {
  const blueprint = JSON.parse(readFileSync(BLUEPRINT, 'utf8')) as {
    validators: { title: string; compiledCode: string }[];
  };
  const v = blueprint.validators.find((x) => x.title === title);
  if (!v) throw new Error(`Validator ${title} not found in plutus.json — run "aiken build"`);
  return v;
}

export type PlutusContracts = {
  /** Settings spend script (canonically wrapped CBOR) and where its UTxO lives. */
  settingsCbor: string;
  settingsHash: string;
  settingsAddress: string;
  /** Prescription minting policy, bound to the settings script hash. */
  policyCbor: string;
  policyId: string;
};

let cached: PlutusContracts | null = null;

/** Builds (once) the settings + policy scripts and their identifiers. */
export function plutusContracts(): PlutusContracts {
  if (cached) return cached;

  const settings = validator('settings.settings.spend');
  const gated = validator('prescription_gated.prescription_gated.mint');

  // Empty params yields the canonically double-CBOR-wrapped script the ledger expects for
  // a spend witness (plutus.json's raw compiledCode is single-encoded → MalformedScriptWitnesses).
  const settingsCbor = applyParamsToScript(settings.compiledCode, [], 'JSON');
  const settingsHash = resolveScriptHash(settingsCbor, 'V3');
  const settingsAddress = serializePlutusScript(
    { code: settingsCbor, version: 'V3' },
    undefined,
    0, // preprod
  ).address;

  const policyCbor = applyParamsToScript(gated.compiledCode, [{ bytes: settingsHash }], 'JSON');
  const policyId = resolveScriptHash(policyCbor, 'V3');

  cached = { settingsCbor, settingsHash, settingsAddress, policyCbor, policyId };
  return cached;
}

/** The inline datum for the settings UTxO: Settings{ admin, doctors, pharmacies }. */
export function settingsDatum(adminHash: string, doctors: string[], pharmacies: string[]) {
  return mConStr0([adminHash, doctors, pharmacies]);
}
