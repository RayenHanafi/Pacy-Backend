/**
 * Checkpoint 2 proof — governance in an on-chain settings UTxO (datum allow-list).
 *
 *   npx tsx onchain/offchain/spike2.ts
 *
 * The payoff over Checkpoint 1: the set of allowed doctors/pharmacies is NOT compiled
 * into the policy. It lives in the datum of a settings UTxO that the minting policy reads
 * as a reference input. Enrolling a new doctor is an admin-signed datum update — no
 * recompile, no new policy id. Proven end to end on preprod:
 *
 *   1. deploy   : a fresh settings UTxO listing doctorA + pharmacy.
 *   2. doctorA mints                          → ACCEPTED (enrolled).
 *   3. doctorB mints                          → REJECTED (not enrolled).
 *   4. admin updates the datum to add doctorB → ACCEPTED (only admin may).
 *   5. doctorB mints (to the pharmacy)        → ACCEPTED (now enrolled) — the payoff.
 *   6. pharmacy burns that token              → ACCEPTED (enrolled to burn).
 *   7. doctorB tries to burn its own token    → REJECTED (not a pharmacy).
 *
 * The settings UTxO is tracked by its exact output reference throughout — unrelated junk
 * that may sit at the shared script address is never touched.
 */
import { MeshTxBuilder, mConStr0, stringToHex, type UTxO } from '@meshsdk/core';
import { loadSettingsWallets, buildContracts, settingsDatum, lovelaceOf, type Contracts } from './lib2.js';
import { provider, type DemoWallet } from './lib.js';

const suffix = Date.now().toString(16);
const nameHex = (p: string) => stringToHex(`${p}${suffix}`);

function newBuilder(): MeshTxBuilder {
  const p = provider();
  return new MeshTxBuilder({ fetcher: p, submitter: p, verbose: false });
}

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

async function submitStaleSafe(address: string, build: (utxos: UTxO[]) => Promise<string>, attempts = 8): Promise<string> {
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

const isRejection = (msg: string): string =>
  /ValidationTagMismatch/.test(msg)
    ? 'ledger rejected it — Plutus script validation failed (ValidationTagMismatch)'
    : /PlutusFailure|ScriptFailure|EvaluationFailure/i.test(msg)
      ? 'Plutus script evaluation failed'
      : msg.split('\n')[0].slice(0, 160);

/** Ensures `target` has `need` UTxOs of >= `min`, funding shortfall from `source`. */
async function ensureFunded(target: DemoWallet, source: DemoWallet, min = 60_000_000n, need = 2) {
  const have = (await provider().fetchAddressUTxOs(target.address)).filter((u) => lovelaceOf(u) >= min);
  if (have.length >= need) return;
  const outputs = need - have.length;
  console.log(`  … funding ${target.role} with ${outputs} UTxO(s) from ${source.role}`);
  await submitStaleSafe(source.address, async (utxos) => {
    let b = newBuilder();
    for (let i = 0; i < outputs; i++) b = b.txOut(target.address, [{ unit: 'lovelace', quantity: String(min) }]);
    const unsigned = await b.changeAddress(source.address).selectUtxosFrom(utxos).complete();
    const signed = await source.wallet.signTx(unsigned, true);
    return source.wallet.submitTx(signed);
  });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    const n = (await provider().fetchAddressUTxOs(target.address)).filter((u) => lovelaceOf(u) >= min).length;
    if (n >= need) return;
  }
  throw new Error(`${target.role} did not reach ${need} funded UTxOs`);
}

/** Polls until the settings output created by `txHash` is visible, and returns it. */
async function settingsFromTx(c: Contracts, txHash: string): Promise<UTxO> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const utxos = await provider().fetchAddressUTxOs(c.settingsAddress);
    const hit = utxos.find((u) => u.input.txHash === txHash);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`settings output from ${txHash} did not appear`);
}

// ── deploy: admin creates a fresh settings UTxO with the given allow-list ─────────────
async function deploySettings(c: Contracts, w: Awaited<ReturnType<typeof loadSettingsWallets>>, doctors: string[], pharmacies: string[]): Promise<UTxO> {
  const datum = settingsDatum(w.admin.keyHash, doctors, pharmacies);
  const tx = await submitStaleSafe(w.admin.address, async (utxos) => {
    const unsigned = await newBuilder()
      .txOut(c.settingsAddress, [{ unit: 'lovelace', quantity: '5000000' }])
      .txOutInlineDatumValue(datum)
      .changeAddress(w.admin.address)
      .selectUtxosFrom(utxos)
      .complete();
    const signed = await w.admin.wallet.signTx(unsigned, true);
    return w.admin.wallet.submitTx(signed);
  });
  return settingsFromTx(c, tx);
}

// ── update: admin spends the settings UTxO and rewrites its datum ─────────────────────
async function updateSettings(c: Contracts, w: Awaited<ReturnType<typeof loadSettingsWallets>>, current: UTxO, doctors: string[], pharmacies: string[]): Promise<{ settings: UTxO; tx: string }> {
  const datum = settingsDatum(w.admin.keyHash, doctors, pharmacies);
  const tx = await submitStaleSafe(w.admin.address, async (adminUtxos) => {
    const { collateral, funding } = pickInputs(adminUtxos);
    if (!collateral || !funding) throw new Error('admin lacks two spendable UTxOs');
    const unsigned = await newBuilder()
      .spendingPlutusScriptV3()
      .txIn(current.input.txHash, current.input.outputIndex, current.output.amount, current.output.address)
      .txInInlineDatumPresent()
      .txInRedeemerValue(mConStr0([]))
      .txInScript(c.settingsCbor)
      .txIn(funding.input.txHash, funding.input.outputIndex, funding.output.amount, funding.output.address)
      .txOut(c.settingsAddress, [{ unit: 'lovelace', quantity: '5000000' }])
      .txOutInlineDatumValue(datum)
      .txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount, collateral.output.address)
      .requiredSignerHash(w.admin.keyHash)
      .changeAddress(w.admin.address)
      .complete();
    const signed = await w.admin.wallet.signTx(unsigned, true);
    return w.admin.wallet.submitTx(signed);
  });
  return { settings: await settingsFromTx(c, tx), tx };
}

// ── mint: a doctor mints a prescription, referencing the settings UTxO ────────────────
async function attemptMint(c: Contracts, minter: DemoWallet, recipient: DemoWallet, assetHex: string, settings: UTxO): Promise<{ ok: boolean; tx?: string; reason?: string }> {
  try {
    const tx = await submitStaleSafe(minter.address, async (utxos) => {
      const { collateral, funding } = pickInputs(utxos);
      if (!collateral || !funding) throw new Error('minter lacks two spendable UTxOs');
      const unsigned = await newBuilder()
        .mintPlutusScriptV3()
        .mint('1', c.policyId, assetHex)
        .mintingScript(c.policyCbor)
        .mintRedeemerValue(mConStr0([]))
        .readOnlyTxInReference(settings.input.txHash, settings.input.outputIndex)
        .txIn(funding.input.txHash, funding.input.outputIndex, funding.output.amount, funding.output.address)
        .txOut(recipient.address, [
          { unit: 'lovelace', quantity: '2000000' },
          { unit: c.policyId + assetHex, quantity: '1' },
        ])
        .txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount, collateral.output.address)
        .requiredSignerHash(minter.keyHash)
        .changeAddress(minter.address)
        .complete();
      const signed = await minter.wallet.signTx(unsigned, true);
      return minter.wallet.submitTx(signed);
    });
    return { ok: true, tx };
  } catch (err) {
    return { ok: false, reason: isRejection(err instanceof Error ? err.message : String(err)) };
  }
}

// ── burn: a holder dispenses (burns) a token, referencing the settings UTxO ───────────
async function attemptBurn(c: Contracts, burner: DemoWallet, assetHex: string, settings: UTxO): Promise<{ ok: boolean; tx?: string; reason?: string }> {
  const unit = c.policyId + assetHex;
  try {
    const tx = await submitStaleSafe(burner.address, async (utxos) => {
      const tokenUtxo = utxos.find((u) => u.output.amount.some((a) => a.unit === unit));
      if (!tokenUtxo) throw new Error('inputs: token not yet visible');
      const { collateral, funding } = pickInputs(utxos.filter((u) => u !== tokenUtxo));
      if (!collateral || !funding) throw new Error('burner lacks spendable UTxOs');
      const unsigned = await newBuilder()
        .mintPlutusScriptV3()
        .mint('-1', c.policyId, assetHex)
        .mintingScript(c.policyCbor)
        .mintRedeemerValue(mConStr0([]))
        .readOnlyTxInReference(settings.input.txHash, settings.input.outputIndex)
        .txIn(tokenUtxo.input.txHash, tokenUtxo.input.outputIndex, tokenUtxo.output.amount, tokenUtxo.output.address)
        .txIn(funding.input.txHash, funding.input.outputIndex, funding.output.amount, funding.output.address)
        .txInCollateral(collateral.input.txHash, collateral.input.outputIndex, collateral.output.amount, collateral.output.address)
        .requiredSignerHash(burner.keyHash)
        .changeAddress(burner.address)
        .complete();
      const signed = await burner.wallet.signTx(unsigned, true);
      return burner.wallet.submitTx(signed);
    });
    return { ok: true, tx };
  } catch (err) {
    return { ok: false, reason: isRejection(err instanceof Error ? err.message : String(err)) };
  }
}

async function waitForToken(address: string, unit: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const utxos = await provider().fetchAddressUTxOs(address);
    if (utxos.some((u) => u.output.amount.some((a) => a.unit === unit))) return;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`timed out waiting for ${unit}`);
}

async function main() {
  const w = await loadSettingsWallets();
  const c = buildContracts();

  console.log(`\nSettings address: ${c.settingsAddress}`);
  console.log(`Settings hash:    ${c.settingsHash}`);
  console.log(`Policy id:        ${c.policyId}\n`);

  console.log('0) Preflight — fund admin and doctorB from doctorA:');
  await ensureFunded(w.admin, w.doctorA);
  await ensureFunded(w.doctorB, w.doctorA);
  console.log('  ✓ admin and doctorB funded\n');

  console.log('1) Deploy a fresh settings UTxO (allow-list: doctorA + pharmacy):');
  let settings = await deploySettings(c, w, [w.doctorA.keyHash], [w.pharmacy.keyHash]);
  console.log(`  ✓ deployed (ref ${settings.input.txHash.slice(0, 12)}…#${settings.input.outputIndex})`);

  console.log('\n2) doctorA (enrolled) mints a prescription:');
  const a = await attemptMint(c, w.doctorA, w.doctorA, nameHex('DOCA'), settings);
  console.log(a.ok ? `  ✓ Accepted. tx: ${a.tx}` : `  ✗ UNEXPECTED rejection: ${a.reason}`);

  console.log('\n3) doctorB (NOT enrolled) mints — should be refused:');
  const b1 = await attemptMint(c, w.doctorB, w.doctorB, nameHex('DOCB1'), settings);
  console.log(b1.ok ? `  ✗ UNEXPECTED: accepted! tx: ${b1.tx}` : `  ✓ Rejected. reason: ${b1.reason}`);

  console.log('\n4) admin updates the datum to ENROLL doctorB:');
  const upd = await updateSettings(c, w, settings, [w.doctorA.keyHash, w.doctorB.keyHash], [w.pharmacy.keyHash]);
  settings = upd.settings;
  console.log(`  ✓ Allow-list updated on-chain (tx ${upd.tx.slice(0, 12)}…) — no recompile`);

  console.log('\n5) doctorB mints again (now enrolled), to the pharmacy — the payoff:');
  const b2 = await attemptMint(c, w.doctorB, w.pharmacy, nameHex('DOCB2'), settings);
  console.log(b2.ok ? `  ✓ Accepted. tx: ${b2.tx}` : `  ✗ UNEXPECTED rejection: ${b2.reason}`);

  let burnOk: { ok: boolean; tx?: string; reason?: string } = { ok: false };
  let doctorBurnRejected = false;
  if (b2.ok) {
    console.log('\n6) pharmacy (enrolled) burns that prescription:');
    await waitForToken(w.pharmacy.address, c.policyId + nameHex('DOCB2'));
    burnOk = await attemptBurn(c, w.pharmacy, nameHex('DOCB2'), settings);
    console.log(burnOk.ok ? `  ✓ Accepted. tx: ${burnOk.tx}` : `  ✗ UNEXPECTED rejection: ${burnOk.reason}`);

    console.log('\n7) doctorB (not a pharmacy) mints then tries to burn — should be refused:');
    const self = await attemptMint(c, w.doctorB, w.doctorB, nameHex('DOCB3'), settings);
    if (self.ok) {
      await waitForToken(w.doctorB.address, c.policyId + nameHex('DOCB3'));
      const burnBad = await attemptBurn(c, w.doctorB, nameHex('DOCB3'), settings);
      doctorBurnRejected = !burnBad.ok;
      console.log(burnBad.ok ? `  ✗ UNEXPECTED: accepted! tx: ${burnBad.tx}` : `  ✓ Rejected. reason: ${burnBad.reason}`);
    }
  }

  const proven = a.ok && !b1.ok && b2.ok && burnOk.ok && doctorBurnRejected;
  console.log('\n─────────────────────────────────────────────');
  console.log(proven ? 'PROVEN on-chain (governance in a datum):' : 'PARTIAL:');
  console.log('  • enrolled doctorA minted            ', a.ok ? '✓' : '✗');
  console.log('  • un-enrolled doctorB was refused    ', !b1.ok ? '✓' : '✗');
  console.log('  • admin enrolled doctorB via datum   ', '✓', `→ https://preprod.cardanoscan.io/transaction/${upd.tx}`);
  console.log('  • doctorB then minted                ', b2.ok ? '✓' : '✗', b2.tx ? `→ https://preprod.cardanoscan.io/transaction/${b2.tx}` : '');
  console.log('  • pharmacy burned                    ', burnOk.ok ? '✓' : '✗', burnOk.tx ? `→ https://preprod.cardanoscan.io/transaction/${burnOk.tx}` : '');
  console.log('  • non-pharmacy burn refused          ', doctorBurnRejected ? '✓' : '✗');
  console.log('  The allow-list changed with zero recompiles — only on-chain data moved.\n');
}

main().catch((err) => {
  console.error('\nspike2 failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
