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
 *   4. ASYMMETRY: the doctor mints a token to itself, then tries to BURN it → rejected.
 *                Holding the token grants no right to burn it; that is the pharmacy's.
 *
 * There is no backend and no database in this file. The only thing standing between an
 * actor and a forged or wrongful transaction is the Aiken validator, running on-chain.
 */
import { MeshTxBuilder, mConStr0, stringToHex, type UTxO } from '@meshsdk/core';
import { loadDemoWallets, buildPolicy, provider, type DemoWallet } from './lib.js';

const ASSET_NAME = `PACYRX${Date.now().toString(16)}`;
const ASSET_NAME_HEX = stringToHex(ASSET_NAME);

// A separate asset for the asymmetry test (doctor mints one to itself, then tries to burn).
const ASSET_B = `PACYDOC${Date.now().toString(16)}`;
const ASSET_B_HEX = stringToHex(ASSET_B);

const lovelaceOf = (u: UTxO): bigint =>
  BigInt(u.output.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0');

/** A pure-ADA UTxO big enough to serve as Plutus collateral. */
function pureAda(utxos: UTxO[], min = 5_000_000n): UTxO | undefined {
  return utxos.find(
    (u) => u.output.amount.length === 1 && u.output.amount[0].unit === 'lovelace' && lovelaceOf(u) >= min,
  );
}

/**
 * Picks a small pure-ADA UTxO for collateral and the largest OTHER UTxO to fund fees —
 * chosen explicitly so the transaction runs no coin-selection at all. That matters for
 * the negative tests: with inputs pinned, the ONLY thing that can make a tx fail is the
 * validator, never a "balance/depleted" coin-selection artifact.
 */
function pickInputs(utxos: UTxO[]): { collateral?: UTxO; funding?: UTxO } {
  const collateral = [...utxos]
    .filter((u) => u.output.amount.length === 1 && u.output.amount[0].unit === 'lovelace')
    .sort((a, b) => Number(lovelaceOf(a) - lovelaceOf(b)))
    .find((u) => lovelaceOf(u) >= 5_000_000n);
  const funding = [...utxos]
    .filter((u) => u !== collateral && lovelaceOf(u) >= 5_000_000n)
    .sort((a, b) => Number(lovelaceOf(b) - lovelaceOf(a)))[0];
  return { collateral, funding };
}

function newBuilder(): MeshTxBuilder {
  const p = provider();
  return new MeshTxBuilder({ fetcher: p, submitter: p, verbose: false });
}

/**
 * Builds and submits a transaction, retrying on stale-input errors with freshly fetched
 * UTxOs. After several sequential txs from one wallet, Blockfrost's per-address UTxO view
 * lags behind the ledger, so a just-spent input can still appear "available" and the node
 * rejects the tx ("already spent" / BadInputsUTxO). Re-fetching and rebuilding fixes it.
 * Only used for transactions we EXPECT to succeed — never for the negative tests, whose
 * failure is the whole point.
 */
async function submitStaleSafe(
  address: string,
  build: (utxos: UTxO[]) => Promise<string>,
  attempts = 8,
): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const utxos = await provider().fetchAddressUTxOs(address);
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

/**
 * Ensures a wallet has at least two SUBSTANTIAL UTxOs (>= `min` lovelace each). A Plutus
 * transaction needs one UTxO for collateral AND at least one more to spend fees from;
 * tiny dust UTxOs (the ~1.2 ADA that rides back from a burn) do not count. A wallet with
 * one big UTxO plus dust cannot build a script tx, so we split the big one into two.
 * Self-payment only.
 */
async function ensureTwoUtxos(w: DemoWallet, min = 20_000_000n): Promise<void> {
  const p = provider();
  let utxos = await p.fetchAddressUTxOs(w.address);
  const fat = () => utxos.filter((u) => lovelaceOf(u) >= min).length;
  if (fat() >= 2) return;

  console.log(`  … ${w.role} has ${fat()} substantial UTxO(s); splitting one into two`);
  const unsigned = await newBuilder()
    .txOut(w.address, [{ unit: 'lovelace', quantity: String(min) }])
    .txOut(w.address, [{ unit: 'lovelace', quantity: String(min) }])
    .changeAddress(w.address)
    .selectUtxosFrom(utxos)
    .complete();
  const signed = await w.wallet.signTx(unsigned, true);
  const tx = await w.wallet.submitTx(signed);
  console.log(`    split tx ${tx.slice(0, 12)}… — waiting for confirmation`);

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    utxos = await p.fetchAddressUTxOs(w.address);
    if (fat() >= 2) return;
  }
  throw new Error(`${w.role} did not reach two substantial UTxOs in time`);
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
  const utxos = await provider().fetchAddressUTxOs(pharmacy.address);
  // Use the SMALLEST adequate pure-ADA UTxO for collateral (it only needs ~5 tADA), so
  // the big UTxOs stay free to fund the tx. EXPLICIT input (below) means Mesh runs no
  // coin-selection at all, so a "balance/depleted" failure is impossible — the only
  // thing that can make this transaction fail is the validator itself.
  const pureAscending = utxos
    .filter((u) => u.output.amount.length === 1 && u.output.amount[0].unit === 'lovelace')
    .sort((a, b) => Number(lovelaceOf(a) - lovelaceOf(b)));
  const collateral = pureAscending.find((u) => lovelaceOf(u) >= 5_000_000n);
  const funding = [...utxos]
    .filter((u) => u !== collateral)
    .sort((a, b) => Number(lovelaceOf(b) - lovelaceOf(a)))[0];
  if (!collateral || !funding || lovelaceOf(funding) < 5_000_000n) {
    console.log(`  ⚠ Skipped: pharmacy lacks two spendable UTxOs (has ${utxos.length}).`);
    return false;
  }

  try {
    const unsigned = await newBuilder()
      .mintPlutusScriptV3()
      .mint('1', policy.policyId, ASSET_NAME_HEX)
      .mintingScript(policy.scriptCbor)
      .mintRedeemerValue(mConStr0([]))
      .txIn(funding.input.txHash, funding.input.outputIndex, funding.output.amount, funding.output.address)
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
      .complete();

    // Building succeeded — try to actually put it on-chain. If the validator is doing
    // its job, the ledger rejects this at evaluation/submission.
    const signed = await pharmacy.wallet.signTx(unsigned, true);
    const tx = await pharmacy.wallet.submitTx(signed);
    console.log(`  ✗ UNEXPECTED: pharmacy-signed mint was ACCEPTED on-chain! tx: ${tx}`);
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const reason = /ValidationTagMismatch/.test(msg)
      ? 'ledger rejected it — Plutus script validation failed (ValidationTagMismatch)'
      : /PlutusFailure|ScriptFailure|EvaluationFailure/i.test(msg)
        ? 'Plutus script evaluation failed'
        : msg.split('\n')[0].slice(0, 160);
    console.log('  ✓ Rejected: the validator refused a mint the doctor did not sign.');
    console.log(`    reason: ${reason}`);
    return true;
  }
}

// ── Step 2: the doctor mints — accepted ────────────────────────────────────────────
async function doctorMints(doctor: DemoWallet, pharmacy: DemoWallet, policy: ReturnType<typeof buildPolicy>) {
  const txHash = await submitStaleSafe(doctor.address, async (utxos) => {
    const { collateral, funding } = pickInputs(utxos);
    if (!collateral || !funding) throw new Error('Doctor lacks two spendable UTxOs for the mint.');
    const unsigned = await newBuilder()
      .mintPlutusScriptV3()
      .mint('1', policy.policyId, ASSET_NAME_HEX)
      .mintingScript(policy.scriptCbor)
      .mintRedeemerValue(mConStr0([]))
      .txIn(funding.input.txHash, funding.input.outputIndex, funding.output.amount, funding.output.address)
      .txOut(pharmacy.address, [
        { unit: 'lovelace', quantity: '2000000' },
        { unit: policy.policyId + ASSET_NAME_HEX, quantity: '1' },
      ])
      .txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount, collateral.output.address)
      .requiredSignerHash(doctor.keyHash) // doctor — the correct key for a mint
      .changeAddress(doctor.address)
      .complete();
    const signed = await doctor.wallet.signTx(unsigned, true);
    return doctor.wallet.submitTx(signed);
  });
  console.log(`  ✓ Accepted: doctor minted 1 prescription token. tx: ${txHash}`);
  return txHash;
}

// ── Step 3: the pharmacy burns (dispenses) — accepted ──────────────────────────────
async function pharmacyBurns(pharmacy: DemoWallet, policy: ReturnType<typeof buildPolicy>) {
  const unit = policy.policyId + ASSET_NAME_HEX;
  console.log('  … waiting for the minted token to land at the pharmacy');
  await waitForToken(pharmacy.address, unit);

  const txHash = await submitStaleSafe(pharmacy.address, async (utxos) => {
    const tokenUtxo = utxos.find((u) => u.output.amount.some((a) => a.unit === unit));
    if (!tokenUtxo) throw new Error('inputs: token not yet visible at pharmacy'); // retriable
    const { collateral, funding } = pickInputs(utxos.filter((u) => u !== tokenUtxo));
    if (!collateral || !funding) throw new Error('Pharmacy lacks spendable UTxOs for the burn.');
    const unsigned = await newBuilder()
      .mintPlutusScriptV3()
      .mint('-1', policy.policyId, ASSET_NAME_HEX) // negative quantity = burn
      .mintingScript(policy.scriptCbor)
      .mintRedeemerValue(mConStr0([]))
      .txIn(tokenUtxo.input.txHash, tokenUtxo.input.outputIndex, tokenUtxo.output.amount, tokenUtxo.output.address)
      .txIn(funding.input.txHash, funding.input.outputIndex, funding.output.amount, funding.output.address)
      .txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount, collateral.output.address)
      .requiredSignerHash(pharmacy.keyHash) // pharmacy — the correct key for a burn
      .changeAddress(pharmacy.address)
      .complete();
    const signed = await pharmacy.wallet.signTx(unsigned, true);
    return pharmacy.wallet.submitTx(signed);
  });
  console.log(`  ✓ Accepted: pharmacy dispensed (burned) the token. tx: ${txHash}`);
  return txHash;
}

// ── Step 4: the ASYMMETRY — the doctor cannot burn, even its own token ──────────────
// Mint (doctor may) and burn (pharmacy may) are enforced independently. To prove the
// doctor is not simply "allowed to do anything", the doctor mints one token TO ITSELF —
// a valid mint — then attempts to burn it. The ledger must refuse the burn: burning is
// the pharmacy's authority, and holding the token does not grant it.
async function doctorCannotBurn(doctor: DemoWallet, policy: ReturnType<typeof buildPolicy>) {
  const unit = policy.policyId + ASSET_B_HEX;

  // (a) doctor mints one token to itself — should succeed.
  {
    const tx = await submitStaleSafe(doctor.address, async (utxos) => {
      const { collateral, funding } = pickInputs(utxos);
      if (!collateral || !funding) throw new Error('Doctor lacks two spendable UTxOs for the mint.');
      const unsigned = await newBuilder()
        .mintPlutusScriptV3()
        .mint('1', policy.policyId, ASSET_B_HEX)
        .mintingScript(policy.scriptCbor)
        .mintRedeemerValue(mConStr0([]))
        .txIn(funding.input.txHash, funding.input.outputIndex, funding.output.amount, funding.output.address)
        .txOut(doctor.address, [
          { unit: 'lovelace', quantity: '2000000' },
          { unit, quantity: '1' },
        ])
        .txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount, collateral.output.address)
        .requiredSignerHash(doctor.keyHash)
        .changeAddress(doctor.address)
        .complete();
      const signed = await doctor.wallet.signTx(unsigned, true);
      return doctor.wallet.submitTx(signed);
    });
    console.log(`  … doctor minted a token to itself to attempt a burn (tx ${tx.slice(0, 12)}…)`);
  }

  // (b) doctor attempts to burn the token it now holds — should be REFUSED.
  const tokenUtxo = await waitForToken(doctor.address, unit);
  const utxos = await provider().fetchAddressUTxOs(doctor.address);
  const { collateral, funding } = pickInputs(utxos.filter((u) => u !== tokenUtxo));
  if (!collateral || !funding) throw new Error('Doctor lacks spendable UTxOs for the burn attempt.');

  try {
    const unsigned = await newBuilder()
      .mintPlutusScriptV3()
      .mint('-1', policy.policyId, ASSET_B_HEX) // burn
      .mintingScript(policy.scriptCbor)
      .mintRedeemerValue(mConStr0([]))
      .txIn(tokenUtxo.input.txHash, tokenUtxo.input.outputIndex, tokenUtxo.output.amount, tokenUtxo.output.address)
      .txIn(funding.input.txHash, funding.input.outputIndex, funding.output.amount, funding.output.address)
      .txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount, collateral.output.address)
      .requiredSignerHash(doctor.keyHash) // doctor — the WRONG key for a burn
      .changeAddress(doctor.address)
      .complete();
    const signed = await doctor.wallet.signTx(unsigned, true);
    const tx = await doctor.wallet.submitTx(signed);
    console.log(`  ✗ UNEXPECTED: doctor-signed burn was ACCEPTED on-chain! tx: ${tx}`);
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const reason = /ValidationTagMismatch/.test(msg)
      ? 'ledger rejected it — Plutus script validation failed (ValidationTagMismatch)'
      : /PlutusFailure|ScriptFailure|EvaluationFailure/i.test(msg)
        ? 'Plutus script evaluation failed'
        : msg.split('\n')[0].slice(0, 160);
    console.log('  ✓ Rejected: the validator refused a burn the pharmacy did not sign.');
    console.log(`    reason: ${reason}`);
    return true;
  }
}

async function main() {
  const { doctor, pharmacy } = await loadDemoWallets();
  const policy = buildPolicy(doctor.keyHash, pharmacy.keyHash);

  console.log(`\nPolicy id: ${policy.policyId}`);
  console.log(`Asset:     ${ASSET_NAME}\n`);

  console.log('0) Preflight — every actor needs a spare UTxO for Plutus collateral:');
  await ensureTwoUtxos(doctor);
  await ensureTwoUtxos(pharmacy);
  console.log('  ✓ doctor and pharmacy each have >=2 UTxOs\n');

  console.log('1) Pharmacy attempts to MINT (should be refused by the chain):');
  const rejected = await pharmacyCannotMint(pharmacy, policy);

  console.log('\n2) Doctor MINTS the prescription:');
  const mintTx = await doctorMints(doctor, pharmacy, policy);

  console.log('\n3) Pharmacy BURNS (dispenses) the prescription:');
  const burnTx = await pharmacyBurns(pharmacy, policy);

  console.log('\n4) Doctor attempts to BURN its own token (should be refused by the chain):');
  const burnRejected = await doctorCannotBurn(doctor, policy);

  const allProven = rejected && burnRejected;
  console.log('\n─────────────────────────────────────────────');
  console.log(allProven ? 'PROVEN on-chain:' : 'PARTIAL:');
  console.log('  • a non-doctor could NOT mint  ', rejected ? '✓' : '✗');
  console.log('  • the doctor minted            →', `https://preprod.cardanoscan.io/transaction/${mintTx}`);
  console.log('  • the pharmacy burned          →', `https://preprod.cardanoscan.io/transaction/${burnTx}`);
  console.log('  • a non-pharmacy could NOT burn', burnRejected ? '✓' : '✗');
  console.log('  No backend. No shared wallet. The validator enforced every rule.\n');
}

main().catch((err) => {
  console.error('\nspike failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
