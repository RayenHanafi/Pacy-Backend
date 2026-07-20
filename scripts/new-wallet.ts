/**
 * Generates a fresh Cardano PREPROD service wallet.
 *
 *   npm run wallet:new
 *
 * Prints a 24-word mnemonic and its address. Paste the mnemonic into .env as
 * SERVICE_WALLET_MNEMONIC, then fund the address from the preprod faucet:
 *   https://docs.cardano.org/cardano-testnets/tools/faucet
 *
 * This mnemonic controls the wallet that signs every mint and burn. Preprod test funds
 * only — but still never commit it or paste it anywhere public.
 */
import { MeshWallet } from '@meshsdk/core';

async function main() {
  const words = MeshWallet.brew() as string[];
  const mnemonic = Array.isArray(words) ? words.join(' ') : String(words);

  const wallet = new MeshWallet({
    networkId: 0, // 0 = testnet (preprod)
    key: { type: 'mnemonic', words: mnemonic.split(' ') },
  });

  // Newer Mesh versions require an explicit init before derivation.
  if (typeof (wallet as { init?: () => Promise<void> }).init === 'function') {
    await (wallet as { init: () => Promise<void> }).init();
  }

  const address = await wallet.getChangeAddress();

  console.log('\n=== Pacy service wallet (PREPROD) ===\n');
  console.log('SERVICE_WALLET_MNEMONIC="%s"\n', mnemonic);
  console.log('Address (fund this from the faucet):\n%s\n', address);
  console.log('Faucet:   https://docs.cardano.org/cardano-testnets/tools/faucet');
  console.log('Explorer: https://preprod.cardanoscan.io/address/%s\n', address);
}

main().catch((err) => {
  console.error('Failed to generate wallet:', err);
  process.exit(1);
});
