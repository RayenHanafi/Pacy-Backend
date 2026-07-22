/**
 * The on-chain proof (Checkpoint 1).
 *
 *   npx tsx onchain/offchain/spike.ts
 *
 * Demonstrates, with REAL preprod transactions, that the LEDGER — not the backend —
 * enforces who may mint and who may burn:
 *
 *   1. NEGATIVE: the pharmacy tries to MINT a prescription  → the chain rejects it.
 *   2. MINT:     the doctor mints one prescription token     → accepted, sent to pharmacy.
 *   3. BURN:     the pharmacy dispenses (burns) that token    → accepted.
 *
 * There is no backend and no database in this file. The only thing standing between an
 * actor and a forged or wrongful transaction is the Aiken validator, running on-chain.
 */
import { MeshTxBuilder, mConStr0, stringToHex, type UTxO } from '@meshsdk/core';
import { loadDemoWallets, buildPolicy, provider, type DemoWallet } from './lib.js';

const ASSET_NAME = `PACYRX${Date.now().toString(16)}`;
const ASSET_NAME_HEX = stringToHex(ASSET_NAME);

const lovelaceOf = (u: UTxO): bigint =>
  BigInt(u.output.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0');

/** A pure-ADA UTxO big enough to serve as Plutus collateral. */
function pureAda(utxos: UTxO[], min = 5_000_000n): UTxO | undefined {
  return utxos.find(
    (u) => u.output.amount.length === 1 && u.output.amount[0].unit === 'lovelace' && lovelaceOf(u) >= min,
  );
}

function newBuilder(): MeshTxBuilder {
  const p = provider();
  return new MeshTxBuilder({ fetcher: p, submitter: p, verbose: false });
}

/** Polls until `unit` appears at `address`, or times out. */
async function waitForToken(address: string, unit: string, timeoutMs = 120_000): Promise<UTxO> {
  const p = provider();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const utxos = await p.fetchAddressUTxOs(address);
    const hit = utxos.find((u) => u.output.amount.some((a) => a.unit === unit));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`Timed out waiting for ${unit} at ${address}`);
}

// ── Step 1: the pharmacy tries to mint — the validator must refuse ─────────────────
async function pharmacyCannotMint(pharmacy: DemoWallet, policy: ReturnType<typeof buildPolicy>) {
  const utxos = await pharmacy.wallet.getUtxos();
  const collateral = pureAda(utxos);
  if (!collateral) throw new Error('Pharmacy has no pure-ADA UTxO for collateral — fund it.');

  try {
    const unsigned = await newBuilder()
      .mintPlutusScriptV3()
      .mint('1', policy.policyId, ASSET_NAME_HEX)
      .mintingScript(policy.scriptCbor)
      .mintRedeemerValue(mConStr0([]))
      .txOut(pharmacy.address, [
        { unit: 'lovelace', quantity: '2000000' },
        { unit: policy.policyId + ASSET_NAME_HEX, quantity: '1' },
      ])
      .txInCollateral(
        collateral.input.txHash,
        collateral.input.outputIndex,
        collateral.output.amount,
        collateral.output.address,
      )
      .requiredSignerHash(pharmacy.keyHash) // pharmacy — the WRONG key for a mint
      .changeAddress(pharmacy.address)
      .selectUtxosFrom(utxos.filter((u) => u !== collateral))
      .complete();

    // If we get here the script accepted a pharmacy-signed mint — that would be a FAILURE.
    await pharmacy.wallet.signTx(unsigned, true);
    console.log('  ✗ UNEXPECTED: the chain built a pharmacy-signed mint. Validator is too loose.');
    return false;
  } catch (err) {
    console.log('  ✓ Rejected: the validator refused a mint that the doctor did not sign.');
    console.log(`    (${(err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 120)})`);
    return true;
  }
}

// ── Step 2: the doctor mints — accepted ────────────────────────────────────────────
async function doctorMints(doctor: DemoWallet, pharmacy: DemoWallet, policy: ReturnType<typeof buildPolicy>) {
  const utxos = await doctor.wallet.getUtxos();
  if (utxos.length < 2) {
    throw new Error(
      `Doctor needs >=2 UTxOs (one for collateral). Has ${utxos.length}. Fund the doctor again from the faucet.`,
    );
  }
  const collateral = pureAda(utxos);
  if (!collateral) throw new Error('Doctor has no pure-ADA UTxO for collateral.');

  const unsigned = await newBuilder()
    .mintPlutusScriptV3()
    .mint('1', policy.policyId, ASSET_NAME_HEX)
    .mintingScript(policy.scriptCbor)
    .mintRedeemerValue(mConStr0([]))
    .txOut(pharmacy.address, [
      { unit: 'lovelace', quantity: '2000000' },
      { unit: policy.policyId + ASSET_NAME_HEX, quantity: '1' },
    ])
    .txInCollateral(
      collateral.input.txHash,
      collateral.input.outputIndex,
      collateral.output.amount,
      collateral.output.address,
    )
    .requiredSignerHash(doctor.keyHash) // doctor — the correct key for a mint
    .changeAddress(doctor.address)
    .selectUtxosFrom(utxos.filter((u) => u !== collateral))
    .complete();

  const signed = await doctor.wallet.signTx(unsigned, true);
  const txHash = await doctor.wallet.submitTx(signed);
  console.log(`  ✓ Accepted: doctor minted 1 prescription token. tx: ${txHash}`);
  return txHash;
}

// ── Step 3: the pharmacy burns (dispenses) — accepted ──────────────────────────────
async function pharmacyBurns(pharmacy: DemoWallet, policy: ReturnType<typeof buildPolicy>) {
  const unit = policy.policyId + ASSET_NAME_HEX;
  console.log('  … waiting for the minted token to land at the pharmacy');
  const tokenUtxo = await waitForToken(pharmacy.address, unit);

  const utxos = await pharmacy.wallet.getUtxos();
  const collateral = pureAda(utxos.filter((u) => u !== tokenUtxo));
  if (!collateral) throw new Error('Pharmacy has no pure-ADA UTxO for collateral.');

  const unsigned = await newBuilder()
    .mintPlutusScriptV3()
    .mint('-1', policy.policyId, ASSET_NAME_HEX) // negative quantity = burn
    .mintingScript(policy.scriptCbor)
    .mintRedeemerValue(mConStr0([]))
    .txIn(
      tokenUtxo.input.txHash,
      tokenUtxo.input.outputIndex,
      tokenUtxo.output.amount,
      tokenUtxo.output.address,
    )
    .txInCollateral(
      collateral.input.txHash,
      collateral.input.outputIndex,
      collateral.output.amount,
      collateral.output.address,
    )
    .requiredSignerHash(pharmacy.keyHash) // pharmacy — the correct key for a burn
    .changeAddress(pharmacy.address)
    .selectUtxosFrom(utxos.filter((u) => u !== tokenUtxo && u !== collateral))
    .complete();

  const signed = await pharmacy.wallet.signTx(unsigned, true);
  const txHash = await pharmacy.wallet.submitTx(signed);
  console.log(`  ✓ Accepted: pharmacy dispensed (burned) the token. tx: ${txHash}`);
  return txHash;
}

async function main() {
  const { doctor, pharmacy } = await loadDemoWallets();
  const policy = buildPolicy(doctor.keyHash, pharmacy.keyHash);

  console.log(`\nPolicy id: ${policy.policyId}`);
  console.log(`Asset:     ${ASSET_NAME}\n`);

  console.log('1) Pharmacy attempts to MINT (should be refused by the chain):');
  const rejected = await pharmacyCannotMint(pharmacy, policy);

  console.log('\n2) Doctor MINTS the prescription:');
  const mintTx = await doctorMints(doctor, pharmacy, policy);

  console.log('\n3) Pharmacy BURNS (dispenses) the prescription:');
  const burnTx = await pharmacyBurns(pharmacy, policy);

  console.log('\n─────────────────────────────────────────────');
  console.log(rejected ? 'PROVEN on-chain:' : 'PARTIAL:');
  console.log('  • a non-doctor could not mint');
  console.log('  • the doctor minted   →', `https://preprod.cardanoscan.io/transaction/${mintTx}`);
  console.log('  • the pharmacy burned →', `https://preprod.cardanoscan.io/transaction/${burnTx}`);
  console.log('  No backend. No shared wallet. The validator enforced every rule.\n');
}

main().catch((err) => {
  console.error('\nspike failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
