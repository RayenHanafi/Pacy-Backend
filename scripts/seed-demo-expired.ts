/**
 * Mints a REAL prescription with a short expiry, so that once the window passes the
 * demo has a genuinely expired token to be refused.
 *
 *   npm run seed:expired            # expires in 10 minutes, against production
 *   npm run seed:expired -- 3       # expires in 3 minutes
 *   BASE_URL=http://localhost:8080 npm run seed:expired
 *
 * Why not just INSERT a row with a past `expires_at`? Because that prescription would
 * carry invented policy/asset/tx values — its "on-chain" links would 404 on Cardanoscan
 * and the refusal would be pure database bookkeeping. Minting for real means the token
 * genuinely exists with a `before(slot)` time-lock, and the ledger itself would reject
 * a burn after it. That is the claim the demo is making, so it should be true.
 *
 * Run this BEFORE the demo — the prescription is dispensable until the expiry passes.
 */
import { createClient } from '@supabase/supabase-js';
import { config } from '../src/config.js';

const BASE = process.env.BASE_URL ?? 'https://pacy-backend-production.up.railway.app';
const PASSWORD = 'PacyDemo123!';
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ1amVteWdvYXd2ZW12d2V3cGxxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyOTY4ODEsImV4cCI6MjA5OTg3Mjg4MX0.Zpb6UHv7bzzAt3O7pr5m_GT9UEEAupMG7TF1Otl68KQ';

const MINUTES = Number(process.argv[2] ?? 10);

async function signIn(email: string): Promise<string> {
  const sb = createClient(config.SUPABASE_URL!, ANON);
  const { data, error } = await sb.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return data.session!.access_token;
}

async function main() {
  if (!Number.isFinite(MINUTES) || MINUTES < 2) {
    throw new Error('Expiry must be at least 2 minutes out — the mint itself needs to confirm.');
  }

  console.log(`\nMinting a demo prescription against ${BASE}`);
  console.log(`Expires in ${MINUTES} minute(s).\n`);

  const [doctorTok, patientTok] = await Promise.all([
    signIn('doctor@pacy.test'),
    signIn('patient@pacy.test'),
  ]);

  const me = await fetch(`${BASE}/me`, { headers: { authorization: `Bearer ${patientTok}` } });
  const patient = await me.json();

  const expiresAt = new Date(Date.now() + MINUTES * 60_000).toISOString();

  const res = await fetch(`${BASE}/prescriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${doctorTok}` },
    body: JSON.stringify({
      patient_id: patient.id,
      drug_details: {
        drug: 'Ciprofloxacin 250mg',
        dosage: '1 tablet twice daily',
        instructions: 'Complete the full course. Short-dated script for demonstration.',
      },
      max_uses: 1,
      expires_at: expiresAt,
    }),
  });

  const body = await res.json();
  if (res.status !== 201) {
    throw new Error(`Mint failed (${res.status}): ${JSON.stringify(body)}`);
  }

  console.log('  ✓ minted');
  console.log(`    id:      ${body.id}`);
  console.log(`    tx:      https://preprod.cardanoscan.io/transaction/${body.mint_tx_hash}`);
  console.log(`    expires: ${expiresAt}`);
  console.log(`\nUntil ${new Date(expiresAt).toLocaleTimeString()} it is a normal dispensable`);
  console.log('prescription. After that it moves into `recently_completed` with status');
  console.log('"expired", and dispensing it returns 409 PRESCRIPTION_EXPIRED.\n');
}

main().catch((err) => {
  console.error('\nFailed:', err?.message ?? err);
  process.exit(1);
});
