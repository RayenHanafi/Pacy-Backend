import { serviceAddress } from '../src/chain/wallet.js';
import { blockfrost } from '../src/chain/provider.js';

const addr = await serviceAddress();
const u = await blockfrost().fetchAddressUTxOs(addr);
const lov = (x: (typeof u)[number]) =>
  Number(x.output.amount.find((a) => a.unit === 'lovelace')?.quantity ?? 0) / 1e6;
const pure = u.filter((x) => x.output.amount.length === 1);
console.log('holding:', addr);
console.log('total UTxOs:', u.length);
console.log('pure-ADA UTxOs:', pure.length, '| values:', pure.map((x) => lov(x).toFixed(1)).sort((a, b) => +b - +a).join(', '));
console.log('pure >= 20 ADA:', pure.filter((x) => lov(x) >= 20).length);
console.log('token-carrying UTxOs:', u.length - pure.length);
process.exit(0);
