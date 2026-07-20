/**
 * E2E for the two list additions:
 *   GET /doctor/prescriptions
 *   recently_completed on the pharmacy scan response
 *
 *   npm run dev        (one terminal)
 *   npm run e2e:lists  (another)
 *
 * Read-only against existing data — submits NO chain transactions, so it runs in
 * seconds. It relies on the lifecycle rows left behind by `npm run e2e:phase5`.
 */
import { createClient } from '@supabase/supabase-js';
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

const HEX64 = /^[0-9a-f]{64}$/;

async function main() {
  console.log(`\nList-endpoint E2E against ${BASE}\n`);

  const [patientTok, doctorTok, pharmacyTok] = await Promise.all([
    signIn('patient@pacy.test'),
    signIn('doctor@pacy.test'),
    signIn('pharmacy@pacy.test'),
  ]);
  const doctorId: string = (await call('/me', { token: doctorTok })).body.id;

  // ── GET /doctor/prescriptions ─────────────────────────────────────────────
  console.log('GET /doctor/prescriptions');
  const list = await call('/doctor/prescriptions', { token: doctorTok });
  check('doctor -> 200', list.status === 200, JSON.stringify(list.body?.error));

  const rows: any[] = list.body?.prescriptions ?? [];
  check('returns prescriptions array', Array.isArray(rows));
  check('has rows to assert against', rows.length > 0, '(run e2e:phase5 first)');

  if (rows.length > 0) {
    const r = rows[0];
    check('  patient is { id, full_name }',
      typeof r.patient?.id === 'string' && typeof r.patient?.full_name === 'string',
      JSON.stringify(r.patient));
    check('  patient.full_name is resolved, not a placeholder',
      r.patient.full_name !== 'Unknown patient', r.patient?.full_name);
    check('  carries events[]', Array.isArray(r.events));
    check('  events are chronological',
      r.events.every((e: any, i: number) =>
        i === 0 || new Date(r.events[i - 1].created_at) <= new Date(e.created_at)));
    check('  status is an effective status',
      ['active', 'fully_dispensed', 'expired', 'revoked'].includes(r.status), r.status);
    check('  every row belongs to this doctor',
      rows.every((x) => x.doctor_id === doctorId));
    check('  newest first',
      rows.every((x, i) =>
        i === 0 || new Date(rows[i - 1].created_at) >= new Date(x.created_at)));
    check('  a revoked prescription is present and revocable-looking',
      rows.some((x) => x.status === 'revoked'), '(none in data)');
  }

  console.log('\n  authorization');
  check('patient -> 403', (await call('/doctor/prescriptions', { token: patientTok })).status === 403);
  check('pharmacy -> 403', (await call('/doctor/prescriptions', { token: pharmacyTok })).status === 403);
  check('no token -> 401', (await call('/doctor/prescriptions')).status === 401);

  // ── recently_completed on the pharmacy scan ───────────────────────────────
  console.log('\nrecently_completed on POST /scan');
  const qr = await call('/patient/qr-token', { token: patientTok });
  const scan = await call('/scan', {
    method: 'POST', token: pharmacyTok, body: { qr_token: qr.body.token },
  });
  check('pharmacy scan -> 200', scan.status === 200, JSON.stringify(scan.body?.error));

  const dispensable: any[] = scan.body?.prescriptions ?? [];
  const completed: any[] = scan.body?.recently_completed ?? [];
  check('recently_completed present for pharmacy', Array.isArray(scan.body?.recently_completed));
  check('has completed rows', completed.length > 0, '(run e2e:phase5 first)');

  const dispensableIds = new Set(dispensable.map((p) => p.id));
  check('the two lists never overlap',
    completed.every((p) => !dispensableIds.has(p.id)));
  check('nothing in recently_completed is dispensable',
    completed.every((p) =>
      p.uses_remaining <= 0 ||
      p.status !== 'active' ||
      (p.expires_at !== null && new Date(p.expires_at).getTime() <= Date.now())));
  check('every completed row carries events[]',
    completed.every((p) => Array.isArray(p.events)));

  const spent = completed.find((p) => p.status === 'fully_dispensed');
  check('a fully_dispensed row exists', Boolean(spent), '(none in data)');
  if (spent) {
    const burns = spent.events.filter((e: any) => e.event_type === 'burn');
    check('  it has burn events with real tx hashes',
      burns.length > 0 && burns.every((e: any) => HEX64.test(e.tx_hash ?? '')),
      JSON.stringify(burns.map((e: any) => e.tx_hash)));
    check('  burn events carry created_at (for "filled on ..." copy)',
      burns.every((e: any) => !Number.isNaN(Date.parse(e.created_at))));

    // The demo finale: this row is offered by the UI and refused by the server.
    console.log('\n*** the finale path: dispensing a recently_completed row ***');
    const refused = await call(`/prescriptions/${spent.id}/dispense`, {
      method: 'POST', token: pharmacyTok,
    });
    check('-> 409 PRESCRIPTION_EXHAUSTED',
      refused.status === 409 && refused.body?.error?.code === 'PRESCRIPTION_EXHAUSTED',
      JSON.stringify(refused.body));
    check('  refusal carries a human-readable message',
      typeof refused.body?.error?.message === 'string' && refused.body.error.message.length > 10,
      refused.body?.error?.message);
  }

  const revokedRow = completed.find((p) => p.status === 'revoked');
  if (revokedRow) {
    const refused = await call(`/prescriptions/${revokedRow.id}/dispense`, {
      method: 'POST', token: pharmacyTok,
    });
    check('revoked row -> 409 PRESCRIPTION_REVOKED',
      refused.status === 409 && refused.body?.error?.code === 'PRESCRIPTION_REVOKED',
      JSON.stringify(refused.body));
  }

  // ── the doctor scan must be unchanged ─────────────────────────────────────
  console.log('\ndoctor scan is unaffected');
  const qr2 = await call('/patient/qr-token', { token: patientTok });
  const docScan = await call('/scan', {
    method: 'POST', token: doctorTok, body: { qr_token: qr2.body.token },
  });
  check('doctor scan -> 200', docScan.status === 200);
  check('  no prescriptions key', docScan.body?.prescriptions === undefined);
  check('  no recently_completed key', docScan.body?.recently_completed === undefined);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`PASSED ${passed}   FAILED ${failed}`);
  console.log('─'.repeat(50) + '\n');
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nE2E failed to run:', err?.message ?? err);
  process.exit(1);
});
