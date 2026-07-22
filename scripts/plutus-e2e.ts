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
  await enrollKeyHash('doctor', d.keyHash);
  await enrollKeyHash('pharmacy', ph.keyHash);
  console.log('  ✓ both enrolled in the settings allow-list\n');

  async function withRetry(label: string, fn: () => Promise<string>): Promise<string> {
    for (let i = 0; i < 6; i++) {
      try {
        return await fn();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/BadInputsUTxO|already spent|already been included|MempoolFailure|inputs/i.test(msg)) {
          console.log(`  … ${label} hit stale inputs, retrying`);
          await new Promise((r) => setTimeout(r, 8_000));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`${label} exhausted retries`);
  }

  console.log('2) MINT — backend builds unsigned, doctor signs, backend co-signs + submits:');
  const mintTx = await withRetry('mint', async () => {
    const mint = await buildMintUnsigned({ doctorKeyHash: d.keyHash, assetNameHex: assetHex, quantity: 1, contentHash });
    const doctorSigned = await doctor.signTx(mint.unsignedTx, true); // the browser step
    return coSignAndSubmit(doctorSigned);
  });
  console.log(`  ✓ minted. tx: ${mintTx}\n`);

  console.log('3) BURN — backend builds unsigned, pharmacy signs, backend co-signs + submits:');
  const burnTx = await withRetry('burn', async () => {
    const burn = await buildBurnUnsigned({ pharmacyKeyHash: ph.keyHash, assetNameHex: assetHex, quantity: 1 });
    const pharmacySigned = await pharmacy.signTx(burn.unsignedTx, true);
    return coSignAndSubmit(pharmacySigned);
  });
  console.log(`  ✓ burned. tx: ${burnTx}\n`);

  console.log('─────────────────────────────────────────────');
  console.log('PROVEN — decentralized flow works via the backend:');
  console.log('  • doctor authorised the mint   →', `https://preprod.cardanoscan.io/transaction/${mintTx}`);
  console.log('  • pharmacy authorised the burn →', `https://preprod.cardanoscan.io/transaction/${burnTx}`);
  console.log('  The backend held the token and paid fees; users only signed.\n');
}

main().catch((err) => {
  console.error('\nplutus-e2e failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
