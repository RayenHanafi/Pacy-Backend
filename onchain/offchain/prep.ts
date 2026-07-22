/**
 * One-time funding fixup when the faucet rate-limits you.
 *
 *   npx tsx onchain/offchain/prep.ts
 *
 * The faucet allows only a request or two per window, so typically only the doctor gets
 * funded. This spends the doctor's single big UTxO to:
 *   - send the PHARMACY a working balance, and
 *   - send the DOCTOR a second output back to itself (Plutus minting needs a spare
 *     UTxO for collateral, separate from the one paying fees).
 *
 * Result: doctor >=2 UTxOs, pharmacy >=1 UTxO — everything the spike needs, no faucet.
 * It is just test ADA moving between two throwaway wallets; the validator is unaffected.
 */
import { MeshTxBuilder } from '@meshsdk/core';
import { loadDemoWallets, provider } from './lib.js';

const TO_PHARMACY = '3000000000'; // 3000 tADA
const TO_DOCTOR_SELF = '3000000000'; // 3000 tADA -> becomes the doctor's collateral UTxO

async function main() {
  const { doctor, pharmacy } = await loadDemoWallets();
  const p = provider();

  const utxos = await doctor.wallet.getUtxos();
  if (utxos.length === 0) {
    throw new Error('Doctor has no funds yet — fund the doctor from the faucet first.');
  }

  const unsigned = await new MeshTxBuilder({ fetcher: p, submitter: p, verbose: false })
    .txOut(pharmacy.address, [{ unit: 'lovelace', quantity: TO_PHARMACY }])
    .txOut(doctor.address, [{ unit: 'lovelace', quantity: TO_DOCTOR_SELF }])
    .changeAddress(doctor.address)
    .selectUtxosFrom(utxos)
    .complete();

  const signed = await doctor.wallet.signTx(unsigned, true);
  const txHash = await doctor.wallet.submitTx(signed);

  console.log('\n✓ Prep transaction submitted:', txHash);
  console.log('  explorer: https://preprod.cardanoscan.io/transaction/' + txHash);
  console.log('\nWait ~30–60s for it to confirm, then check:');
  console.log('  npm run onchain:wallets');
  console.log('Expect: doctor >=2 UTxOs, pharmacy >=1 UTxO.\n');
}

main().catch((err) => {
  console.error('\nprep failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
