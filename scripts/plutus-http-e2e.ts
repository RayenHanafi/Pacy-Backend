/**
 * Path A HTTP end-to-end — drives the real routes over HTTP with real JWTs, signing with
 * a browser-simulated MeshWallet exactly as the frontend will.
 *
 *   npm run dev            (one terminal)
 *   npm run plutus:http    (another)
 *
 * Validates the endpoints the frontend integrates against: /chain/wallet enrolment, then
 * prepare -> sign -> commit for both mint and dispense. Submits REAL preprod transactions.
 */
import { createClient } from '@supabase/supabase-js';
import { MeshWallet, deserializeAddress } from '@meshsdk/core';
import { config } from '../src/config.js';

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const PASSWORD = 'PacyDemo123!';
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ1amVteWdvYXd2ZW12d2V3cGxxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyOTY4ODEsImV4cCI6MjA5OTg3Mjg4MX0.Zpb6UHv7bzzAt3O7pr5m_GT9UEEAupMG7TF1Otl68KQ';

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} ${detail}`); }
}

async function signIn(email: string): Promise<string> {
  const sb = createClient(config.SUPABASE_URL!, ANON);
  const { data, error } = await sb.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return data.session!.access_token;
}

async function call(path: string, opts: { token?: string; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

/** Stands in for the browser wallet — key only, no provider (signing needs neither). */
async function browserWallet() {
  const words = (MeshWallet.brew() as string[]).join(' ').split(' ');
  const wallet = new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words } });
  const maybeInit = (wallet as unknown as { init?: () => Promise<void> }).init;
  if (typeof maybeInit === 'function') await maybeInit.call(wallet);
  const address = await wallet.getChangeAddress();
  return { wallet, address, keyHash: deserializeAddress(address).pubKeyHash };
}

async function main() {
  console.log(`\nPath A HTTP E2E against ${BASE}\n`);

  const [patientTok, doctorTok, pharmacyTok] = await Promise.all([
    signIn('patient@pacy.test'),
    signIn('doctor@pacy.test'),
    signIn('pharmacy@pacy.test'),
  ]);
  const patientId: string = (await call('/me', { token: patientTok })).body.id;

  const drug = {
    medicines: [
      { drug: 'Metformin 500mg', dosage: '1 tablet twice daily', instructions: 'Take with meals.' },
      { drug: 'Lisinopril 10mg', dosage: '1 tablet daily', instructions: 'Take in the morning.' },
    ],
    diagnosis: 'Type 2 diabetes with hypertension',
  };

  console.log('ENROLMENT (on-chain allow-list update — slow, ~30–60s each)');
  const doctor = await browserWallet();
  const pharmacy = await browserWallet();

  const enrolDoc = await call('/chain/wallet', {
    method: 'POST', token: doctorTok, body: { address: doctor.address, key_hash: doctor.keyHash },
  });
  check('doctor enrols wallet -> 201', enrolDoc.status === 201, JSON.stringify(enrolDoc.body));

  const enrolPh = await call('/chain/wallet', {
    method: 'POST', token: pharmacyTok, body: { address: pharmacy.address, key_hash: pharmacy.keyHash },
  });
  check('pharmacy enrols wallet -> 201', enrolPh.status === 201, JSON.stringify(enrolPh.body));

  const status = await call('/chain/wallet', { token: doctorTok });
  check('GET /chain/wallet shows enrolled', status.body?.enrolled === true && status.body?.key_hash === doctor.keyHash);

  console.log('\nMINT — prepare -> sign -> commit (2 refills)');
  const prep = await call('/prescriptions/prepare', {
    method: 'POST', token: doctorTok,
    body: { patient_id: patientId, drug_details: drug, max_uses: 2, expires_at: null },
  });
  check('prepare -> 201 with unsigned_tx', prep.status === 201 && typeof prep.body?.unsigned_tx === 'string', JSON.stringify(prep.body));
  const prescriptionId: string = prep.body.prescription_id;

  const doctorSigned = await doctor.wallet.signTx(prep.body.unsigned_tx, true);
  const commit = await call('/prescriptions/commit', {
    method: 'POST', token: doctorTok, body: { prescription_id: prescriptionId, signed_tx: doctorSigned },
  });
  check('commit -> 200 with mint_tx_hash', commit.status === 200 && /^[0-9a-f]{64}$/.test(commit.body?.mint_tx_hash ?? ''), JSON.stringify(commit.body));
  check('  status active, uses_remaining 2', commit.body?.status === 'active' && commit.body?.uses_remaining === 2);
  if (commit.body?.mint_tx_hash) console.log(`     mint tx: https://preprod.cardanoscan.io/transaction/${commit.body.mint_tx_hash}`);

  async function dispense() {
    const dprep = await call(`/prescriptions/${prescriptionId}/dispense/prepare`, { method: 'POST', token: pharmacyTok });
    if (dprep.status !== 200 || typeof dprep.body?.unsigned_tx !== 'string') {
      return { prepOk: false, dprep, dcommit: undefined as any };
    }
    const signed = await pharmacy.wallet.signTx(dprep.body.unsigned_tx, true);
    const dcommit = await call(`/prescriptions/${prescriptionId}/dispense/commit`, {
      method: 'POST', token: pharmacyTok, body: { signed_tx: signed },
    });
    return { prepOk: true, dprep, dcommit };
  }

  console.log('\nDISPENSE #1 — burn one refill (2 -> 1)');
  const d1 = await dispense();
  check('dispense #1 -> 200 with burn_tx_hash', d1.dcommit?.status === 200 && /^[0-9a-f]{64}$/.test(d1.dcommit?.body?.burn_tx_hash ?? ''), JSON.stringify(d1.dcommit?.body));
  check('  uses_remaining 1', d1.dcommit?.body?.uses_remaining === 1);
  if (d1.dcommit?.body?.burn_tx_hash) console.log(`     burn tx: https://preprod.cardanoscan.io/transaction/${d1.dcommit.body.burn_tx_hash}`);

  console.log('  … waiting ~30s for the remaining token (with its datum) to settle');
  await new Promise((r) => setTimeout(r, 30_000));

  console.log('DISPENSE #2 — burn the LAST refill (1 -> 0) — the multi-refill datum test');
  const d2 = await dispense();
  check('dispense #2 -> 200 with burn_tx_hash', d2.dcommit?.status === 200 && /^[0-9a-f]{64}$/.test(d2.dcommit?.body?.burn_tx_hash ?? ''), JSON.stringify(d2.dcommit?.body));
  check('  uses_remaining 0 (remaining token carried its datum)', d2.dcommit?.body?.uses_remaining === 0);
  if (d2.dcommit?.body?.burn_tx_hash) console.log(`     burn tx: https://preprod.cardanoscan.io/transaction/${d2.dcommit.body.burn_tx_hash}`);

  console.log('\nAUTH GUARDS');
  const phTriesMint = await call('/prescriptions/prepare', {
    method: 'POST', token: pharmacyTok,
    body: { patient_id: patientId, drug_details: drug, max_uses: 1, expires_at: null },
  });
  check('pharmacy cannot prepare a mint -> 403', phTriesMint.status === 403, `got ${phTriesMint.status}`);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`PASSED ${passed}   FAILED ${failed}`);
  console.log('─'.repeat(50) + '\n');
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nHTTP E2E failed to run:', err?.message ?? err);
  process.exit(1);
});
