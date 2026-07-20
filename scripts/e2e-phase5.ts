/**
 * Phase 5 end-to-end — the full prescription lifecycle and every rejection path.
 *
 *   npm run dev         (one terminal)
 *   npm run e2e:phase5  (another)
 *
 * Submits REAL mint and burn transactions to Cardano preprod. Takes a few minutes,
 * because each chain write waits for the wallet to settle before the next one starts.
 */
import { createClient } from '@supabase/supabase-js';
import { config } from '../src/config.js';
import { db } from '../src/db/client.js';

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

async function call(
  path: string,
  opts: { token?: string; method?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
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

const drug = {
  drug: 'Amoxicillin 500mg',
  dosage: '1 capsule three times daily',
  instructions: 'Take with food.',
};

async function main() {
  console.log(`\nPhase 5 E2E against ${BASE}\n`);

  const [patientTok, doctorTok, pharmacyTok] = await Promise.all([
    signIn('patient@pacy.test'),
    signIn('doctor@pacy.test'),
    signIn('pharmacy@pacy.test'),
  ]);
  const me = await call('/me', { token: patientTok });
  const patientId: string = me.body.id;
  const doctorId: string = (await call('/me', { token: doctorTok })).body.id;

  // ── mint a 2-fill prescription ────────────────────────────────────────────
  console.log('SETUP: minting a 2-fill prescription');
  const rx = await call('/prescriptions', {
    method: 'POST', token: doctorTok,
    body: { patient_id: patientId, drug_details: drug, max_uses: 2, expires_at: null },
  });
  check('minted with uses_remaining 2',
    rx.status === 201 && rx.body?.uses_remaining === 2, JSON.stringify(rx.body?.error));
  const rxId: string = rx.body.id;
  console.log(`     tx: https://preprod.cardanoscan.io/transaction/${rx.body.mint_tx_hash}`);

  // ── authorization ─────────────────────────────────────────────────────────
  console.log('\nAUTHORIZATION');
  const byDoctor = await call(`/prescriptions/${rxId}/dispense`, { method: 'POST', token: doctorTok });
  check('doctor cannot dispense -> 403', byDoctor.status === 403, `got ${byDoctor.status}`);
  const byPatient = await call(`/prescriptions/${rxId}/dispense`, { method: 'POST', token: patientTok });
  check('patient cannot dispense -> 403', byPatient.status === 403, `got ${byPatient.status}`);

  // ── dispense 1 of 2 ───────────────────────────────────────────────────────
  console.log('\nDISPENSE 1 of 2 — burning on preprod');
  const d1 = await call(`/prescriptions/${rxId}/dispense`, { method: 'POST', token: pharmacyTok });
  check('dispense -> 200', d1.status === 200, JSON.stringify(d1.body?.error));
  check('  uses_remaining 2 -> 1', d1.body?.uses_remaining === 1, String(d1.body?.uses_remaining));
  check('  still active', d1.body?.status === 'active');
  check('  burn_tx_hash is 64-hex', /^[0-9a-f]{64}$/.test(d1.body?.burn_tx_hash ?? ''));
  console.log(`     tx: https://preprod.cardanoscan.io/transaction/${d1.body?.burn_tx_hash}`);

  // ── dispense 2 of 2 ───────────────────────────────────────────────────────
  console.log('\nDISPENSE 2 of 2 — should exhaust it');
  const d2 = await call(`/prescriptions/${rxId}/dispense`, { method: 'POST', token: pharmacyTok });
  check('dispense -> 200', d2.status === 200, JSON.stringify(d2.body?.error));
  check('  uses_remaining 1 -> 0', d2.body?.uses_remaining === 0, String(d2.body?.uses_remaining));
  check('  status "fully_dispensed"', d2.body?.status === 'fully_dispensed', d2.body?.status);
  console.log(`     tx: https://preprod.cardanoscan.io/transaction/${d2.body?.burn_tx_hash}`);

  // ── THE DEMO MOMENT: reuse is refused ─────────────────────────────────────
  console.log('\n*** REUSE ATTEMPT — the core demo moment ***');
  const d3 = await call(`/prescriptions/${rxId}/dispense`, { method: 'POST', token: pharmacyTok });
  check('third dispense -> 409 PRESCRIPTION_EXHAUSTED',
    d3.status === 409 && d3.body?.error?.code === 'PRESCRIPTION_EXHAUSTED',
    JSON.stringify(d3.body));

  // ── expired prescription is refused ───────────────────────────────────────
  console.log('\nEXPIRED PRESCRIPTION');
  // Inserted directly with a past expiry — minting one would mean waiting for it.
  const { data: expiredRow } = await db()
    .from('prescriptions')
    .insert({
      patient_id: patientId, doctor_id: doctorId, drug_details: drug,
      content_hash: 'e'.repeat(64), max_uses: 1, uses_remaining: 1,
      expires_at: new Date(Date.now() - 86_400_000).toISOString(),
      policy_id: 'a'.repeat(56), asset_name: 'b'.repeat(32),
      mint_tx_hash: 'c'.repeat(64), status: 'active',
    })
    .select('id')
    .single();

  const expiredDispense = await call(`/prescriptions/${expiredRow!.id}/dispense`, {
    method: 'POST', token: pharmacyTok,
  });
  check('expired dispense -> 409 PRESCRIPTION_EXPIRED',
    expiredDispense.status === 409 && expiredDispense.body?.error?.code === 'PRESCRIPTION_EXPIRED',
    JSON.stringify(expiredDispense.body));

  const history0 = await call('/patient/prescriptions', { token: patientTok });
  const expiredInHistory = history0.body.prescriptions.find((p: any) => p.id === expiredRow!.id);
  check('expired reads status "expired" in history',
    expiredInHistory?.status === 'expired', expiredInHistory?.status);

  const notFound = await call('/prescriptions/00000000-0000-0000-0000-000000000000/dispense', {
    method: 'POST', token: pharmacyTok,
  });
  check('unknown prescription -> 404', notFound.status === 404, `got ${notFound.status}`);

  // ── revoke ────────────────────────────────────────────────────────────────
  console.log('\nREVOKE');
  const rx2 = await call('/prescriptions', {
    method: 'POST', token: doctorTok,
    body: { patient_id: patientId, drug_details: drug, max_uses: 3, expires_at: null },
  });
  const rx2Id: string = rx2.body.id;
  check('minted a 3-fill prescription to revoke', rx2.status === 201);

  const revokeByPharmacy = await call(`/prescriptions/${rx2Id}/revoke`, {
    method: 'POST', token: pharmacyTok,
  });
  check('pharmacy cannot revoke -> 403', revokeByPharmacy.status === 403);

  const revoked = await call(`/prescriptions/${rx2Id}/revoke`, { method: 'POST', token: doctorTok });
  check('doctor revoke -> 200', revoked.status === 200, JSON.stringify(revoked.body?.error));
  check('  status "revoked"', revoked.body?.status === 'revoked');
  check('  uses_remaining 0', revoked.body?.uses_remaining === 0);
  check('  burned all remaining on-chain',
    /^[0-9a-f]{64}$/.test(revoked.body?.burn_tx_hash ?? ''), revoked.body?.burn_tx_hash);
  console.log(`     tx: https://preprod.cardanoscan.io/transaction/${revoked.body?.burn_tx_hash}`);

  const dispenseRevoked = await call(`/prescriptions/${rx2Id}/dispense`, {
    method: 'POST', token: pharmacyTok,
  });
  check('dispensing a revoked prescription -> 409 PRESCRIPTION_REVOKED',
    dispenseRevoked.status === 409 && dispenseRevoked.body?.error?.code === 'PRESCRIPTION_REVOKED',
    JSON.stringify(dispenseRevoked.body));

  // ── audit trail ───────────────────────────────────────────────────────────
  console.log('\nAUDIT TRAIL');
  const history = await call('/patient/prescriptions', { token: patientTok });
  const dispensed = history.body.prescriptions.find((p: any) => p.id === rxId);
  const types = (dispensed?.events ?? []).map((e: any) => e.event_type);
  check('events are mint, burn, burn', JSON.stringify(types) === '["mint","burn","burn"]',
    JSON.stringify(types));
  check('  burns attributed to pharmacy',
    dispensed.events.filter((e: any) => e.event_type === 'burn')
      .every((e: any) => e.actor_role === 'pharmacy'));

  const { data: burnEvents } = await db()
    .from('token_events')
    .select('station_id')
    .eq('prescription_id', rxId)
    .eq('event_type', 'burn');
  check('  burns record the dispensing station',
    (burnEvents ?? []).every((e: any) => e.station_id !== null), JSON.stringify(burnEvents));

  const revokedRx = history.body.prescriptions.find((p: any) => p.id === rx2Id);
  check('revoked prescription still visible in patient history',
    revokedRx?.status === 'revoked');

  // ── pharmacy no longer offers it ──────────────────────────────────────────
  console.log('\nPHARMACY VIEW AFTER LIFECYCLE');
  const qr = await call('/patient/qr-token', { token: patientTok });
  const scan = await call('/scan', {
    method: 'POST', token: pharmacyTok, body: { qr_token: qr.body.token },
  });
  const offered = scan.body.prescriptions.map((p: any) => p.id);
  check('exhausted prescription is NOT offered', !offered.includes(rxId));
  check('revoked prescription is NOT offered', !offered.includes(rx2Id));
  check('expired prescription is NOT offered', !offered.includes(expiredRow!.id));

  await db().from('prescriptions').delete().eq('id', expiredRow!.id);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`PASSED ${passed}   FAILED ${failed}`);
  console.log('─'.repeat(50) + '\n');
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nE2E failed to run:', err?.message ?? err);
  process.exit(1);
});
