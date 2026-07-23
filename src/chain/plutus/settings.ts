/**
 * Manages the on-chain settings UTxO (the allow-list) for the Plutus path.
 *
 * The backend's holding wallet is the settings `admin`, so it alone can deploy and update
 * the datum. The datum's doctor/pharmacy arrays are mirrored in chain_config (the backend
 * is the source of truth); enrolling a practitioner appends their key hash and rewrites
 * the datum on-chain. The policy id never changes, so prior prescriptions stay valid.
 */
import { mConStr0, type UTxO } from '@meshsdk/core';
import { plutusContracts, settingsDatum } from './config.js';
import { holdingWallet, holdingAddress, holdingKeyHash } from './backendWallet.js';
import { newBuilder, pickInputs, submitStaleSafe, utxoFromTx } from './txHelpers.js';
import { getChainConfig, setChainConfig, type ChainConfigRow } from '../../db/chain.js';
import { blockfrost } from '../provider.js';
import { AppError } from '../../lib/errors.js';

// The settings UTxO holds the whole allow-list in its datum, so its min-ADA grows with the
// number of enrolled practitioners. Hold a generous amount (refundable when respent) so a
// realistic allow-list never trips BabbageOutputTooSmallUTxO.
const SETTINGS_ADA = '10000000';

async function deployFreshSettings(doctors: string[], pharmacies: string[]): Promise<UTxO> {
  const c = plutusContracts();
  const admin = await holdingKeyHash();
  const datum = settingsDatum(admin, doctors, pharmacies);
  const address = await holdingAddress();

  const tx = await submitStaleSafe(address, async (utxos) => {
    const wallet = await holdingWallet();
    const unsigned = await newBuilder()
      .txOut(c.settingsAddress, [{ unit: 'lovelace', quantity: SETTINGS_ADA }])
      .txOutInlineDatumValue(datum)
      .changeAddress(address)
      .selectUtxosFrom(utxos)
      .complete();
    const signed = await wallet.signTx(unsigned, true);
    return wallet.submitTx(signed);
  });
  return utxoFromTx(c.settingsAddress, tx);
}

async function updateSettingsOnChain(current: UTxO, doctors: string[], pharmacies: string[]): Promise<UTxO> {
  const c = plutusContracts();
  const admin = await holdingKeyHash();
  const datum = settingsDatum(admin, doctors, pharmacies);
  const address = await holdingAddress();

  const tx = await submitStaleSafe(address, async (utxos) => {
    const { collateral, funding } = pickInputs(utxos);
    if (!collateral || !funding) throw new Error('holding wallet lacks two spendable UTxOs');
    const wallet = await holdingWallet();
    const unsigned = await newBuilder()
      .spendingPlutusScriptV3()
      .txIn(current.input.txHash, current.input.outputIndex, current.output.amount, current.output.address)
      .txInInlineDatumPresent()
      .txInRedeemerValue(mConStr0([]))
      .txInScript(c.settingsCbor)
      .txIn(funding.input.txHash, funding.input.outputIndex, funding.output.amount, funding.output.address)
      .txOut(c.settingsAddress, [{ unit: 'lovelace', quantity: SETTINGS_ADA }])
      .txOutInlineDatumValue(datum)
      .txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount, collateral.output.address)
      .requiredSignerHash(admin)
      .changeAddress(address)
      .complete();
    const signed = await wallet.signTx(unsigned, true);
    return wallet.submitTx(signed);
  });
  return utxoFromTx(c.settingsAddress, tx);
}

/** Deploys the settings UTxO on first use; returns the current chain_config row. */
export async function ensureSettingsDeployed(): Promise<ChainConfigRow> {
  const existing = await getChainConfig();
  if (existing?.settings_tx_hash) return existing;

  const c = plutusContracts();
  const utxo = await deployFreshSettings([], []);
  return setChainConfig({
    policy_id: c.policyId,
    settings_address: c.settingsAddress,
    settings_tx_hash: utxo.input.txHash,
    settings_output_index: utxo.input.outputIndex,
    doctors: [],
    pharmacies: [],
  });
}

/** The live settings UTxO, resolved from the ref stored in chain_config. */
export async function currentSettingsUtxo(): Promise<UTxO> {
  const cfg = await getChainConfig();
  if (!cfg?.settings_tx_hash || cfg.settings_output_index === null || !cfg.settings_address) {
    throw new AppError('CHAIN_NOT_INITIALISED', 'Settings UTxO is not deployed — run bootstrap first');
  }
  const utxos = await blockfrost().fetchAddressUTxOs(cfg.settings_address);
  const hit = utxos.find(
    (u) => u.input.txHash === cfg.settings_tx_hash && u.input.outputIndex === cfg.settings_output_index,
  );
  if (!hit) throw new AppError('CHAIN_NOT_INITIALISED', 'Recorded settings UTxO not found on-chain');
  return hit;
}

/** Adds a key hash to the doctor or pharmacy allow-list and updates the datum on-chain. */
export async function enrollKeyHash(role: 'doctor' | 'pharmacy', keyHash: string): Promise<{ added: boolean; tx?: string }> {
  const cfg = await ensureSettingsDeployed();
  const doctors = [...cfg.doctors];
  const pharmacies = [...cfg.pharmacies];
  const list = role === 'doctor' ? doctors : pharmacies;

  if (list.includes(keyHash)) return { added: false };
  list.push(keyHash);

  const current = await currentSettingsUtxo();
  const updated = await updateSettingsOnChain(current, doctors, pharmacies);

  await setChainConfig({
    policy_id: cfg.policy_id!,
    settings_address: cfg.settings_address!,
    settings_tx_hash: updated.input.txHash,
    settings_output_index: updated.input.outputIndex,
    doctors,
    pharmacies,
  });
  return { added: true, tx: updated.input.txHash };
}
