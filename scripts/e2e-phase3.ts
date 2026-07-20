/**
 * Phase 3 end-to-end check — exercises auth, the rotating QR, and both scan paths
 * against a running server.
 *
 *   npm run dev          (in one terminal)
 *   npm run e2e:phase3   (in another)
 *
 * Signs in as the real seeded users through Supabase, so this verifies genuine JWT
 * verification rather than a mock.
 */
import { createClient } from '@supabase/supabase-js';
import { config } from '../src/config.js';
import { db } from '../src/db/client.js';
import { generateStationKey } from '../src/lib/hash.js';

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const PASSWORD = 'PacyDemo123!';

// Public anon key — safe in source; it is the browser-facing key.
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ1amVteWdvYXd2ZW12d2V3cGxxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyOTY4ODEsImV4cCI6MjA5OTg3Mjg4MX0.Zpb6UHv7bzzAt3O7pr5m_GT9UEEAupMG7TF1Otl68KQ';

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label} ${detail}`);
  }
}

async function signIn(email: string): Promise<string> {
  const sb = createClient(config.SUPABASE_URL!, ANON);
  const { data, error } = await sb.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return data.session!.access_token;
}

type Res = { status: number; body: any };

async function call(
  path: string,
  opts: { token?: string; stationKey?: string; method?: string; body?: unknown } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.stationKey) headers['x-station-key'] = opts.stationKey;

  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function main() {
  console.log(`\nPhase 3 E2E against ${BASE}\n`);

  // Rotate station keys so this test is independent of when `npm run seed` last ran.
  const doctorKey = generateStationKey();
  const pharmacyKey = generateStationKey();
  await db().from('stations').update({ api_key_hash: doctorKey.hash }).eq('type', 'doctor');
  await db().from('stations').update({ api_key_hash: pharmacyKey.hash }).eq('type', 'pharmacy');

  // Clear leftover scans — a previous run's scan can still be inside the freshness
  // window and would make the "nobody scanned yet" assertion pass or fail by timing.
  await db().from('station_scans').delete().neq('station_id', '00000000-0000-0000-0000-000000000000');

  const [patientTok, doctorTok, pharmacyTok] = await Promise.all([
    signIn('patient@pacy.test'),
    signIn('doctor@pacy.test'),
    signIn('pharmacy@pacy.test'),
  ]);
  console.log('signed in as all three roles\n');

  // ---- auth ----
  console.log('AUTH');
  const noAuth = await call('/me');
  check('GET /me without token -> 401 UNAUTHORIZED',
    noAuth.status === 401 && noAuth.body?.error?.code === 'UNAUTHORIZED',
    JSON.stringify(noAuth.body));

  const badAuth = await call('/me', { token: 'not-a-real-jwt' });
  check('GET /me with garbage token -> 401',
    badAuth.status === 401, `got ${badAuth.status}`);

  const patientMe = await call('/me', { token: patientTok });
  check('GET /me as patient -> role "patient"',
    patientMe.body?.role === 'patient', JSON.stringify(patientMe.body));
  check('  patient station_id is null', patientMe.body?.station_id === null);
  check('  patient verification is null', patientMe.body?.verification === null);

  const doctorMe = await call('/me', { token: doctorTok });
  check('GET /me as doctor -> role "doctor"', doctorMe.body?.role === 'doctor');
  check('  doctor station_id present', typeof doctorMe.body?.station_id === 'string');
  check('  doctor verification HPCSA/verified',
    doctorMe.body?.verification?.body === 'HPCSA' &&
      doctorMe.body?.verification?.status === 'verified',
    JSON.stringify(doctorMe.body?.verification));

  const pharmacyMe = await call('/me', { token: pharmacyTok });
  check('GET /me as pharmacy -> verification SAPC/verified',
    pharmacyMe.body?.verification?.body === 'SAPC' &&
      pharmacyMe.body?.verification?.status === 'verified');

  // ---- QR ----
  console.log('\nPATIENT QR');
  const qr = await call('/patient/qr-token', { token: patientTok });
  check('GET /patient/qr-token as patient -> token', typeof qr.body?.token === 'string');
  check(`  expires_in === ${config.QR_TOKEN_TTL_SECONDS}`,
    qr.body?.expires_in === config.QR_TOKEN_TTL_SECONDS, String(qr.body?.expires_in));

  const qrAsDoctor = await call('/patient/qr-token', { token: doctorTok });
  check('GET /patient/qr-token as doctor -> 403 FORBIDDEN',
    qrAsDoctor.status === 403 && qrAsDoctor.body?.error?.code === 'FORBIDDEN');

  const qrToken: string = qr.body.token;

  // ---- station scan (IoT path) ----
  console.log('\nSTATION SCAN (IoT path)');
  const badStation = await call('/stations/scan', {
    method: 'POST', stationKey: 'pacy_st_wrong', body: { qr_token: qrToken },
  });
  check('POST /stations/scan bad key -> INVALID_STATION_KEY',
    badStation.body?.error?.code === 'INVALID_STATION_KEY', JSON.stringify(badStation.body));

  const pharmScan = await call('/stations/scan', {
    method: 'POST', stationKey: pharmacyKey.raw, body: { qr_token: qrToken },
  });
  check('POST /stations/scan (pharmacy) -> 200', pharmScan.status === 200,
    JSON.stringify(pharmScan.body));
  check('  returns patient name',
    pharmScan.body?.patient?.full_name === 'Thabo Dlamini', JSON.stringify(pharmScan.body?.patient));
  check('  station_type "pharmacy"', pharmScan.body?.station_type === 'pharmacy');
  check('  prescriptions array present (pharmacy)',
    Array.isArray(pharmScan.body?.prescriptions));

  const badQr = await call('/stations/scan', {
    method: 'POST', stationKey: pharmacyKey.raw, body: { qr_token: 'bogus.qr.token' },
  });
  check('POST /stations/scan bad QR -> INVALID_QR_TOKEN (422)',
    badQr.status === 422 && badQr.body?.error?.code === 'INVALID_QR_TOKEN',
    JSON.stringify(badQr.body));

  // ---- browser poll ----
  console.log('\nBROWSER POLL');
  const poll = await call('/stations/current-scan', { token: pharmacyTok });
  check('GET /stations/current-scan (pharmacy) -> 200 with the scan',
    poll.status === 200 && poll.body?.patient?.id === pharmScan.body?.patient?.id,
    `status ${poll.status}`);

  const doctorPoll = await call('/stations/current-scan', { token: doctorTok });
  check('GET /stations/current-scan (doctor, nobody scanned) -> 204',
    doctorPoll.status === 204, `got ${doctorPoll.status}`);

  const patientPoll = await call('/stations/current-scan', { token: patientTok });
  check('GET /stations/current-scan as patient -> 403',
    patientPoll.status === 403, `got ${patientPoll.status}`);

  // ---- camera fallback ----
  console.log('\nCAMERA FALLBACK');
  const fresh = await call('/patient/qr-token', { token: patientTok });
  const camera = await call('/scan', {
    method: 'POST', token: doctorTok, body: { qr_token: fresh.body.token },
  });
  check('POST /scan as doctor -> 200', camera.status === 200, JSON.stringify(camera.body));
  check('  station_type "doctor"', camera.body?.station_type === 'doctor');
  check('  no prescriptions list for doctor', camera.body?.prescriptions === undefined);

  const cameraAsPatient = await call('/scan', {
    method: 'POST', token: patientTok, body: { qr_token: fresh.body.token },
  });
  check('POST /scan as patient -> 403', cameraAsPatient.status === 403);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`PASSED ${passed}   FAILED ${failed}`);
  console.log('─'.repeat(50) + '\n');
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nE2E failed to run:', err?.message ?? err);
  process.exit(1);
});
