/**
 * Seeds the demo accounts and IoT stations.
 *
 *   npm run seed
 *
 * Idempotent for accounts (re-running reuses existing users), but station API keys are
 * regenerated every run and printed ONCE — copy them to the IoT devices.
 *
 * Doctors and pharmacies are seeded as already-verified because neither HPCSA nor SAPC
 * exposes an automated verification API (see PROJECT.md §8).
 */
import { db } from '../src/db/client.js';
import { generateStationKey } from '../src/lib/hash.js';

const PASSWORD = 'PacyDemo123!';

type SeedUser = {
  email: string;
  role: 'patient' | 'doctor' | 'pharmacy';
  full_name: string;
};

const USERS: SeedUser[] = [
  { email: 'doctor@pacy.test', role: 'doctor', full_name: 'Dr. Naledi Mokoena' },
  { email: 'pharmacy@pacy.test', role: 'pharmacy', full_name: 'Sandton Central Pharmacy' },
  { email: 'patient@pacy.test', role: 'patient', full_name: 'Thabo Dlamini' },
];

async function findUserByEmail(email: string): Promise<string | null> {
  // listUsers paginates; the seed set is tiny so one page is plenty.
  const { data, error } = await db().auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  return data.users.find((u) => u.email === email)?.id ?? null;
}

async function ensureUser(user: SeedUser): Promise<string> {
  const existing = await findUserByEmail(user.email);
  if (existing) {
    console.log(`  · ${user.email} already exists`);
    return existing;
  }

  const { data, error } = await db().auth.admin.createUser({
    email: user.email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  console.log(`  + created ${user.email}`);
  return data.user.id;
}

async function main() {
  console.log('\nSeeding Pacy demo data...\n');

  console.log('Accounts:');
  const ids: Record<string, string> = {};
  for (const user of USERS) {
    const id = await ensureUser(user);
    ids[user.role] = id;

    const { error } = await db()
      .from('profiles')
      .upsert({ id, role: user.role, full_name: user.full_name }, { onConflict: 'id' });
    if (error) throw error;
  }

  const doctorId = ids.doctor!;
  const pharmacyId = ids.pharmacy!;

  // Regulator registrations — verified, per the seeded-registry approach.
  const now = new Date().toISOString();
  const { error: docErr } = await db().from('doctors').upsert(
    {
      user_id: doctorId,
      hpcsa_number: 'MP0123456',
      verification_status: 'verified',
      verified_at: now,
    },
    { onConflict: 'user_id' },
  );
  if (docErr) throw docErr;

  const { error: pharmErr } = await db().from('pharmacies').upsert(
    {
      user_id: pharmacyId,
      sapc_number: 'P00123456',
      verification_status: 'verified',
      verified_at: now,
    },
    { onConflict: 'user_id' },
  );
  if (pharmErr) throw pharmErr;
  console.log('  ✓ doctor verified (HPCSA MP0123456), pharmacy verified (SAPC P00123456)');

  // Stations: wipe and recreate so the printed keys are always the live ones.
  await db().from('stations').delete().in('owner_user_id', [doctorId, pharmacyId]);

  const doctorKey = generateStationKey();
  const pharmacyKey = generateStationKey();

  const { data: stations, error: stErr } = await db()
    .from('stations')
    .insert([
      {
        type: 'doctor',
        label: 'Doctor Station 01',
        owner_user_id: doctorId,
        api_key_hash: doctorKey.hash,
      },
      {
        type: 'pharmacy',
        label: 'Pharmacy Station 01',
        owner_user_id: pharmacyId,
        api_key_hash: pharmacyKey.hash,
      },
    ])
    .select('id, type, label');
  if (stErr) throw stErr;

  const doctorStation = stations?.find((s) => s.type === 'doctor');
  const pharmacyStation = stations?.find((s) => s.type === 'pharmacy');

  console.log('\n─────────────────────────────────────────────────────────');
  console.log('LOGIN (all three accounts share this password)');
  console.log('─────────────────────────────────────────────────────────');
  for (const u of USERS) console.log(`  ${u.role.padEnd(9)} ${u.email}`);
  console.log(`  password  ${PASSWORD}`);

  console.log('\n─────────────────────────────────────────────────────────');
  console.log('STATION API KEYS — shown ONCE, copy to the Raspberry Pis');
  console.log('─────────────────────────────────────────────────────────');
  console.log(`  Doctor   station_id=${doctorStation?.id}`);
  console.log(`           X-Station-Key: ${doctorKey.raw}`);
  console.log(`  Pharmacy station_id=${pharmacyStation?.id}`);
  console.log(`           X-Station-Key: ${pharmacyKey.raw}`);
  console.log('─────────────────────────────────────────────────────────\n');
  console.log('Seed complete.\n');
}

main().catch((err) => {
  console.error('\nSeed failed:', err.message ?? err);
  process.exit(1);
});
