/**
 * Prints the two demo wallets (generating them on first run) and the policy id their
 * key hashes produce. Fund BOTH addresses from the preprod faucet before running the
 * spike, and fund the doctor twice (it needs a spare UTxO for Plutus collateral).
 *
 *   npx tsx onchain/offchain/gen-wallets.ts
 */
import { loadDemoWallets, buildPolicy, provider } from './lib.js';

async function balance(addr: string): Promise<string> {
  try {
    const utxos = await provider().fetchAddressUTxOs(addr);
    const lovelace = utxos.reduce((sum, u) => {
      const a = u.output.amount.find((x) => x.unit === 'lovelace');
      return sum + (a ? BigInt(a.quantity) : 0n);
    }, 0n);
    return `${Number(lovelace) / 1_000_000} tADA across ${utxos.length} UTxO(s)`;
  } catch {
    return '(could not fetch — new/empty address)';
  }
}

async function main() {
  const { doctor, pharmacy } = await loadDemoWallets();
  const policy = buildPolicy(doctor.keyHash, pharmacy.keyHash);

  for (const w of [doctor, pharmacy]) {
    console.log(`\n=== ${w.role.toUpperCase()} wallet (PREPROD) ===`);
    console.log('address:  ', w.address);
    console.log('key hash: ', w.keyHash);
    console.log('balance:  ', await balance(w.address));
    console.log('explorer: ', `https://preprod.cardanoscan.io/address/${w.address}`);
  }

  console.log('\n=== Policy (bound to the two key hashes above) ===');
  console.log('policy id:', policy.policyId);
  console.log('\nFaucet: https://docs.cardano.org/cardano-testnets/tools/faucet');
  console.log('Fund the PHARMACY once, and the DOCTOR twice (it needs a collateral UTxO).\n');
}

main().catch((err) => {
  console.error('gen-wallets failed:', err);
  process.exit(1);
});
