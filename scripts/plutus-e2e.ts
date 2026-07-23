/**
 * Backend Path A end-to-end test — simulates the browser wallet with a Node MeshWallet.
 *
 *   npm run plutus:e2e
 *
 * Proves the decentralized flow WITHOUT a frontend: the backend builds an unsigned tx,
 * a user key (generated here, standing in for the browser) signs it, the backend co-signs
 * with the holding wallet and submits. The on-chain policy enforces doctor-for-mint and
 * pharmacy-for-burn against the settings allow-list. Submits REAL preprod transactions.
 */
import { MeshWallet, deserializeAddress, stringToHex } from '@meshsdk/core';
import { blockfrost } from '../src/chain/provider.js';
import { ensureSettingsDeployed, enrollKeyHash } from '../src/chain/plutus/settings.js';
import { ensureHoldingUtxos } from '../src/chain/plutus/backendWallet.js';
import { buildMintUnsigned, buildBurnUnsigned, coSignAndSubmit } from '../src/chain/plutus/prescriptionTx.js';

function browserWallet() {
  const p = blockfrost();
  const words = (MeshWallet.brew() as string[]).join(' ').split(' ');
  const wallet = new MeshWallet({ networkId: 0, fetcher: p, submitter: p, key: { type: 'mnemonic', words } });
  return wallet;
}

async function ready(wallet: MeshWallet) {
  const maybeInit = (wallet as unknown as { init?: () => Promise<void> }).init;
  if (typeof maybeInit === 'function') await maybeInit.call(wallet);
  const address = await wallet.getChangeAddress();
  return { address, keyHash: deserializeAddress(address).pubKeyHash };
}

/** Wait for a tx to confirm, then let Blockfrost's per-address UTxO index catch up. */
async function settle(txHash: string): Promise<void> {
  const p = blockfrost();
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      await p.fetchTxInfo(txHash);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  await new Promise((r) => setTimeout(r, 12_000));
}

async function main() {
  const asset = `PLRX${Date.now().toString(16)}`;
  const assetHex = stringToHex(asset);
  const contentHash = '00'.repeat(32);

  console.log('0) Ensure holding wallet has collateral UTxOs + settings deployed:');
  await ensureHoldingUtxos();
  const cfg = await ensureSettingsDeployed();
  console.log(`  ✓ settings at ${cfg.settings_address} (policy ${cfg.policy_id})\n`);

  const doctor = browserWallet();
  const d = await ready(doctor);
  const pharmacy = browserWallet();
  const ph = await ready(pharmacy);
  console.log(`doctor key   ${d.keyHash}`);
  console.log(`pharmacy key ${ph.keyHash}\n`);

  console.log('1) Enroll doctor + pharmacy on-chain (admin datum update):');
  const ed = await enrollKeyHash('doctor', d.keyHash);
  if (ed.tx) await settle(ed.tx);
  const ep = await enrollKeyHash('pharmacy', ph.keyHash);
  if (ep.tx) await settle(ep.tx);
  console.log('  ✓ both enrolled in the settings allow-list\n');

  async function withRetry(label: string, fn: () => Promise<string>): Promise<string> {
    for (let i = 0; i < 6; i++) {
      try {
        return await fn();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/BadInputsUTxO|All inputs are spent|already been included|MempoolFailure/i.test(msg)) {
          console.log(`  … ${label} hit stale inputs, retrying`);
          await new Promise((r) => setTimeout(r, 8_000));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`${label} exhausted retries`);
  }

  const doMint = (aHex: string, expiresAt: Date | null) =>
    withRetry('mint', async () => {
      const mint = await buildMintUnsigned({ doctorKeyHash: d.keyHash, assetNameHex: aHex, quantity: 1, contentHash, expiresAt });
      const signed = await doctor.signTx(mint.unsignedTx, true); // the browser step
      const tx = await coSignAndSubmit(signed);
      await settle(tx);
      return tx;
    });
  const doBurn = (aHex: string, expiresAt: Date | null) =>
    withRetry('burn', async () => {
      const burn = await buildBurnUnsigned({ pharmacyKeyHash: ph.keyHash, assetNameHex: aHex, quantity: 1, expiresAt });
      const signed = await pharmacy.signTx(burn.unsignedTx, true);
      const tx = await coSignAndSubmit(signed);
      await settle(tx);
      return tx;
    });

  console.log('2) MINT (no expiry) — doctor signs, backend co-signs + submits:');
  const mintTx = await doMint(assetHex, null);
  console.log(`  ✓ minted. tx: ${mintTx}\n`);

  console.log('3) BURN (no expiry) — pharmacy signs, backend co-signs + submits:');
  const burnTx = await doBurn(assetHex, null);
  console.log(`  ✓ burned. tx: ${burnTx}\n`);

  // Expiry is enforced on-chain: the token carries its expiry as an inline datum, and the
  // policy rejects a burn whose validity range extends past it.
  const future = new Date(Date.now() + 60 * 60 * 1000); // +1h
  const later = new Date(Date.now() + 3 * 60 * 60 * 1000); // +3h

  console.log('4) EXPIRY (valid) — mint with a future expiry, then burn before it:');
  const aValid = stringToHex(`EXPOK${Date.now().toString(16)}`);
  await doMint(aValid, future);
  const validExpiryBurn = await doBurn(aValid, future);
  console.log(`  ✓ burned before expiry. tx: ${validExpiryBurn}\n`);

  console.log('5) EXPIRY (violated) — burn whose validity extends PAST the token expiry:');
  const aExpired = stringToHex(`EXPNO${Date.now().toString(16)}`);
  await doMint(aExpired, future); // token datum expiry = +1h
  let expiryRejected = false;
  try {
    // Build the burn bounded to +3h — later than the +1h expiry baked into the token.
    await doBurn(aExpired, later);
    console.log('  ✗ UNEXPECTED: a past-expiry burn was accepted');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    expiryRejected = /ValidationTagMismatch|PlutusFailure|ScriptFailure|EvaluationFailure|OutsideValidityInterval/i.test(msg);
    console.log(`  ${expiryRejected ? '✓' : '✗'} Rejected by the validator (expiry enforced on-chain)`);
    console.log(`    reason: ${msg.split('\n')[0].slice(0, 140)}`);
  }

  console.log('\n─────────────────────────────────────────────');
  console.log(expiryRejected ? 'PROVEN — decentralized flow + on-chain expiry:' : 'PARTIAL:');
  console.log('  • doctor authorised the mint   →', `https://preprod.cardanoscan.io/transaction/${mintTx}`);
  console.log('  • pharmacy authorised the burn →', `https://preprod.cardanoscan.io/transaction/${burnTx}`);
  console.log('  • burn before expiry accepted  →', `https://preprod.cardanoscan.io/transaction/${validExpiryBurn}`);
  console.log('  • burn past expiry refused     ', expiryRejected ? '✓' : '✗');
  console.log('  The backend held the token and paid fees; users only signed.\n');
  if (!expiryRejected) process.exit(1);
}

main().catch((err) => {
  console.error('\nplutus-e2e failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
