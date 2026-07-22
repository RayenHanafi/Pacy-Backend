import { loadDemoWallets, provider } from './lib.js';

const { doctor, pharmacy } = await loadDemoWallets();
const p = provider();
for (const w of [doctor, pharmacy]) {
  const u = await p.fetchAddressUTxOs(w.address);
  console.log(`\n${w.role}: ${u.length} UTxOs`);
  u.forEach((x, i) => {
    const parts = x.output.amount.map((a) =>
      a.unit === 'lovelace' ? `${Number(a.quantity) / 1e6} ADA` : `${a.quantity} token(${a.unit.slice(-8)})`,
    );
    console.log(`  [${i}] ${parts.join(' + ')}`);
  });
}
