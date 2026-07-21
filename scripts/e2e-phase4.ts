/**
 * Phase 4 end-to-end — the doctor mint flow, against a running server.
 *
 *   npm run dev         (one terminal)
 *   npm run e2e:phase4  (another)
 *
 * This submits REAL transactions to Cardano preprod.
 */
import { createClient } from '@supabase/supabase-js';
import { config } from '../src/config.js';
import { db } from '../src/db/client.js';
import {
  enrolDoctorKey,
  generateDoctorKey,
  prescriptionBody,
  signContent,
} from './lib/doctor-signing.js';

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

async function main() {
  console.log(`\nPhase 4 E2E against ${BASE}\n`);

  const [patientTok, doctorTok, pharmacyTok] = await Promise.all([
    signIn('patient@pacy.test'),
    signIn('doctor@pacy.test'),
    signIn('pharmacy@pacy.test'),
  ]);

  const me = await call('/me', { token: patientTok });
  const patientId: string = me.body.id;
  const doctorId: string = (await call('/me', { token: doctorTok })).body.id;

  // Stands in for the key the doctor's browser would hold.
  const key = await enrolDoctorKey(BASE, doctorTok);

  const drug = {
    drug: 'Amoxicillin 500mg',
    dosage: '1 capsule three times daily',
    instructions: 'Take with food. Complete the full course.',
    diagnosis: 'Bacterial throat infection',
  };

  // ---- authorization ----
  console.log('AUTHORIZATION');
  const asPharmacy = await call('/prescriptions', {
    method: 'POST', token: pharmacyTok,
    body: { patient_id: patientId, drug_details: drug, max_uses: 1, expires_at: null },
  });
  check('pharmacy cannot mint -> 403', asPharmacy.status === 403, `got ${asPharmacy.status}`);

  const asPatient = await call('/prescriptions', {
    method: 'POST', token: patientTok,
    body: { patient_id: patientId, drug_details: drug, max_uses: 1, expires_at: null },
  });
  check('patient cannot mint -> 403', asPatient.status === 403, `got ${asPatient.status}`);

  // ---- validation ----
  console.log('\nVALIDATION');
  const badUses = await call('/prescriptions', {
    method: 'POST', token: doctorTok,
    body: { patient_id: patientId, drug_details: drug, max_uses: 0, expires_at: null },
  });
  check('max_uses 0 -> 400 VALIDATION_ERROR',
    badUses.status === 400 && badUses.body?.error?.code === 'VALIDATION_ERROR',
    JSON.stringify(badUses.body));

  const pastExpiryContent = {
    patient_id: patientId, doctor_id: doctorId, drug_details: drug, max_uses: 1,
    expires_at: new Date(Date.now() - 86_400_000).toISOString(),
  };
  const pastExpiry = await call('/prescriptions', {
    method: 'POST', token: doctorTok, body: prescriptionBody(key, pastExpiryContent),
  });
  check('expires_at in the past -> 400',
    pastExpiry.status === 400, JSON.stringify(pastExpiry.body));

  const unknownContent = {
    patient_id: '00000000-0000-0000-0000-000000000000',
    doctor_id: doctorId, drug_details: drug, max_uses: 1, expires_at: null,
  };
  const unknownPatient = await call('/prescriptions', {
    method: 'POST', token: doctorTok, body: prescriptionBody(key, unknownContent),
  });
  check('unknown patient -> 404', unknownPatient.status === 404, `got ${unknownPatient.status}`);

  // ---- doctor signature ----
  //
  // The reason this feature exists: without a valid signature from a key only the doctor
  // holds, this backend could mint a prescription attributed to a doctor who never wrote
  // it. These three cases are that guarantee.
  console.log('\nDOCTOR SIGNATURE');
  const validContent = {
    patient_id: patientId, doctor_id: doctorId, drug_details: drug,
    max_uses: 1, expires_at: null,
  };

  const noSig = await call('/prescriptions', {
    method: 'POST', token: doctorTok,
    body: { patient_id: patientId, drug_details: drug, max_uses: 1, expires_at: null },
  });
  check('missing signature -> 400', noSig.status === 400, `got ${noSig.status}`);

  const foreignKey = generateDoctorKey();
  const wrongSigner = await call('/prescriptions', {
    method: 'POST', token: doctorTok,
    body: { ...prescriptionBody(key, validContent), doctor_signature: signContent(foreignKey, validContent) },
  });
  check('signature from an unenrolled key -> 422 INVALID_DOCTOR_SIGNATURE',
    wrongSigner.status === 422 && wrongSigner.body?.error?.code === 'INVALID_DOCTOR_SIGNATURE',
    JSON.stringify(wrongSigner.body?.error));

  // Sign 1 refill, then ask for 30. The signature is genuine; the request is not what was
  // signed. This is the tamper case that matters — a compromised backend rewriting a
  // doctor's prescription on its way to the chain.
  const tampered = await call('/prescriptions', {
    method: 'POST', token: doctorTok,
    body: { ...prescriptionBody(key, validContent), max_uses: 30 },
  });
  check('altered body after signing -> 422 INVALID_DOCTOR_SIGNATURE',
    tampered.status === 422 && tampered.body?.error?.code === 'INVALID_DOCTOR_SIGNATURE',
    JSON.stringify(tampered.body?.error));

  const beforeCount = (await call('/patient/prescriptions', { token: patientTok }))
    .body.prescriptions.length;

  // ---- mint: no expiry, 3 refills ----
  console.log('\nMINT (no expiry, 3 refills) — submitting to Cardano preprod');
  const created = await call('/prescriptions', {
    method: 'POST', token: doctorTok,
    body: prescriptionBody(key, {
      patient_id: patientId, doctor_id: doctorId,
      drug_details: drug, max_uses: 3, expires_at: null,
    }),
  });
  check('POST /prescriptions -> 201', created.status === 201, JSON.stringify(created.body));
  check('  uses_remaining === max_uses === 3',
    created.body?.max_uses === 3 && created.body?.uses_remaining === 3);
  check('  status "active"', created.body?.status === 'active');
  check('  mint_tx_hash is 64-char hex',
    /^[0-9a-f]{64}$/.test(created.body?.mint_tx_hash ?? ''), created.body?.mint_tx_hash);
  check('  policy_id is 56-char hex',
    /^[0-9a-f]{56}$/.test(created.body?.policy_id ?? ''), created.body?.policy_id);
  check('  asset_name is 32-char hex',
    /^[0-9a-f]{32}$/.test(created.body?.asset_name ?? ''), created.body?.asset_name);
  check('  content_hash is sha256 hex',
    /^[0-9a-f]{64}$/.test(created.body?.content_hash ?? ''));
  console.log(`     tx: https://preprod.cardanoscan.io/transaction/${created.body?.mint_tx_hash}`);

  // ---- mint: with expiry ----
  console.log('\nMINT (expires in 24h, 1 fill)');
  const expiry = new Date(Date.now() + 86_400_000).toISOString();
  const timed = await call('/prescriptions', {
    method: 'POST', token: doctorTok,
    body: prescriptionBody(key, {
      patient_id: patientId, doctor_id: doctorId,
      drug_details: drug, max_uses: 1, expires_at: expiry,
    }),
  });
  check('POST /prescriptions with expiry -> 201', timed.status === 201, JSON.stringify(timed.body));
  check('  expires_at echoed back', timed.body?.expires_at !== null);
  check('  time-locked policy differs from the no-expiry one',
    timed.body?.policy_id !== created.body?.policy_id);
  console.log(`     tx: https://preprod.cardanoscan.io/transaction/${timed.body?.mint_tx_hash}`);

  // ---- audit trail ----
  console.log('\nAUDIT TRAIL & HISTORY');
  const { data: events } = await db()
    .from('token_events')
    .select('event_type, actor_role, tx_hash')
    .eq('prescription_id', created.body.id);
  check('mint recorded in token_events',
    events?.length === 1 && events[0]!.event_type === 'mint' && events[0]!.actor_role === 'doctor',
    JSON.stringify(events));
  check('  event tx_hash matches the mint', events?.[0]?.tx_hash === created.body.mint_tx_hash);

  const history = await call('/patient/prescriptions', { token: patientTok });
  check('GET /patient/prescriptions -> 200', history.status === 200);
  check('  two new prescriptions visible',
    history.body?.prescriptions?.length === beforeCount + 2,
    `${history.body?.prescriptions?.length} vs ${beforeCount + 2}`);
  const mine = history.body.prescriptions.find((p: any) => p.id === created.body.id);
  check('  includes the minted prescription', Boolean(mine));
  check('  carries its events array',
    Array.isArray(mine?.events) && mine.events[0]?.event_type === 'mint',
    JSON.stringify(mine?.events));

  const doctorHistory = await call('/patient/prescriptions', { token: doctorTok });
  check('doctor cannot read patient history -> 403', doctorHistory.status === 403);

  // ---- pharmacy sees it as dispensable ----
  console.log('\nPHARMACY VIEW');
  const qr = await call('/patient/qr-token', { token: patientTok });
  const scan = await call('/scan', {
    method: 'POST', token: pharmacyTok, body: { qr_token: qr.body.token },
  });
  check('pharmacy scan lists dispensable prescriptions',
    Array.isArray(scan.body?.prescriptions) && scan.body.prescriptions.length >= 2,
    `${scan.body?.prescriptions?.length}`);
  check('  minted prescription appears in the dispensable list',
    scan.body.prescriptions.some((p: any) => p.id === created.body.id));

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`PASSED ${passed}   FAILED ${failed}`);
  console.log('─'.repeat(50) + '\n');
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nE2E failed to run:', err?.message ?? err);
  process.exit(1);
});
