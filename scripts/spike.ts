/**
 * Phase 2 chain spike — proves the whole Cardano design on preprod before any of it is
 * wired into HTTP routes.
 *
 *   npm run spike
 *
 * Test 1: no-expiry policy  -> mint 3 units, burn 1, confirm balance drops to 2.
 * Test 2: time-locked policy -> mint 2 units under `all[sig, before(slot)]`, burn 1
 *         inside the validity window.
 * Test 3: expiry enforcement -> attempt a burn with `invalidHereafter` already in the
 *         past. The ledger must REJECT it. This is the guarantee the whole product
 *         rests on, so we assert it rather than assume it.
 */
import { Transaction } from '@meshsdk/core';
import { randomUUID } from 'node:crypto';
import { serviceWallet, serviceAddress } from '../src/chain/wallet.js';
import { buildPolicy, assetNameFor, assetUnit } from '../src/chain/policy.js';
import { waitForTx } from '../src/chain/confirm.js';
import { waitForAssetQuantity } from '../src/chain/assets.js';
import { slotForDate, currentSlot } from '../src/chain/slots.js';
import { canonicalJson, sha256Hex } from '../src/lib/hash.js';

const EXPLORER = 'https://preprod.cardanoscan.io/transaction/';

/** Waits for the UTxO set to actually reflect `expected`, returning it (or throwing). */
async function settleAt(unit: string, expected: number): Promise<number> {
  const address = await serviceAddress();
  return waitForAssetQuantity(address, unit, expected);
}

async function mint(
  forgingScript: string,
  assetName: string,
  quantity: number,
  contentHash: string,
  expirySlot?: number,
): Promise<string> {
  const wallet = await serviceWallet();
  const address = await serviceAddress();

  const tx = new Transaction({ initiator: wallet });
  tx.mintAsset(forgingScript, {
    assetName,
    assetQuantity: String(quantity),
    recipient: address,
  });

  // Content hash only — never drug details, never anything identifying a patient.
  tx.setMetadata(674, { hash: contentHash, v: 1 });

  // The tx must not outlive the policy's own time-lock.
  if (expirySlot !== undefined) tx.setTimeToExpire(String(expirySlot));

  const unsigned = await tx.build();
  const signed = await wallet.signTx(unsigned);
  return wallet.submitTx(signed);
}

async function burn(
  forgingScript: string,
  unit: string,
  quantity: number,
  expirySlot?: number,
): Promise<string> {
  const wallet = await serviceWallet();

  const tx = new Transaction({ initiator: wallet });
  tx.burnAsset(forgingScript, { unit, quantity: String(quantity) });
  if (expirySlot !== undefined) tx.setTimeToExpire(String(expirySlot));

  const unsigned = await tx.build();
  const signed = await wallet.signTx(unsigned);
  return wallet.submitTx(signed);
}

async function main() {
  const address = await serviceAddress();
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  Pacy chain spike — Cardano preprod                      ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('service wallet :', address.slice(0, 24) + '...' + address.slice(-8));
  console.log('current slot   :', currentSlot(), '\n');

  const contentHash = sha256Hex(
    canonicalJson({ drug: 'Amoxicillin 500mg', dosage: '1 capsule 3x daily', max_uses: 3 }),
  );
  console.log('content hash   :', contentHash, '\n');

  // ─────────────────────────────────────────────────────────────
  // TEST 1 — no expiry: mint 3, burn 1
  // ─────────────────────────────────────────────────────────────
  console.log('── TEST 1: no-expiry prescription (3 refills) ──');
  const rx1 = randomUUID();
  const policy1 = buildPolicy(address, null);
  const name1 = assetNameFor(rx1);
  const unit1 = assetUnit(policy1.policyId, name1);

  console.log('policy id  :', policy1.policyId);
  console.log('asset name :', name1);

  const mint1 = await mint(policy1.forgingScript, name1, 3, contentHash);
  console.log('MINT 3 ->', mint1);
  console.log('          ', EXPLORER + mint1);
  await waitForTx(mint1);
  const after1 = await settleAt(unit1, 3);
  console.log('settled. on-chain quantity =', after1, '✓');

  const burn1 = await burn(policy1.forgingScript, unit1, 1);
  console.log('BURN 1 ->', burn1);
  console.log('          ', EXPLORER + burn1);
  await waitForTx(burn1);
  const after2 = await settleAt(unit1, 2);
  console.log('settled. on-chain quantity =', after2, '✓');

  // ─────────────────────────────────────────────────────────────
  // TEST 2 — time-locked policy, burn inside the window
  // ─────────────────────────────────────────────────────────────
  console.log('\n── TEST 2: time-locked prescription (expires in 24h) ──');
  const rx2 = randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const policy2 = buildPolicy(address, expiresAt);
  const name2 = assetNameFor(rx2);
  const unit2 = assetUnit(policy2.policyId, name2);

  console.log('policy id  :', policy2.policyId);
  console.log('asset name :', name2);
  console.log('expiry slot:', policy2.expirySlot, `(${expiresAt.toISOString()})`);

  const mint2 = await mint(policy2.forgingScript, name2, 2, contentHash, policy2.expirySlot);
  console.log('MINT 2 ->', mint2);
  console.log('          ', EXPLORER + mint2);
  await waitForTx(mint2);
  console.log('settled. on-chain quantity =', await settleAt(unit2, 2), '✓');

  const burn2 = await burn(policy2.forgingScript, unit2, 1, policy2.expirySlot);
  console.log('BURN 1 ->', burn2);
  console.log('          ', EXPLORER + burn2);
  await waitForTx(burn2);
  const after3 = await settleAt(unit2, 1);
  console.log('settled. on-chain quantity =', after3, '✓');

  // ─────────────────────────────────────────────────────────────
  // TEST 3 — expiry must BLOCK a burn (the core demo guarantee)
  // ─────────────────────────────────────────────────────────────
  console.log('\n── TEST 3: burn after expiry must be REJECTED ──');
  const pastSlot = slotForDate(new Date(Date.now() - 60 * 60 * 1000));
  console.log('using invalidHereafter =', pastSlot, '(1 hour in the past)');

  let rejected = false;
  let reason = '';
  try {
    const bad = await burn(policy2.forgingScript, unit2, 1, pastSlot);
    console.log('✗ UNEXPECTED: chain accepted an expired burn ->', bad);
  } catch (err) {
    rejected = true;
    reason = err instanceof Error ? err.message : String(err);
    console.log('✓ REJECTED as required');
    console.log('  reason:', reason.slice(0, 300));
  }

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  RESULT                                                  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('mint N units          :', after1 === 3 ? 'PASS' : 'FAIL');
  console.log('burn 1 decrements     :', after2 === 2 ? 'PASS' : 'FAIL');
  console.log('time-locked mint/burn :', after3 === 1 ? 'PASS' : 'FAIL');
  console.log('expiry blocks burn    :', rejected ? 'PASS' : 'FAIL');
  console.log('');
}

main().catch((err) => {
  console.error('\nSpike failed:', err?.message ?? err);
  if (err?.stack) console.error(err.stack.split('\n').slice(1, 5).join('\n'));
  process.exit(1);
});
