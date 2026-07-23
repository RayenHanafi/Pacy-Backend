/**
 * Adds two extra verified accounts for testing — doctor2 + pharmacy2, same password.
 *
 *   npm run seed:extra
 *
 * Idempotent (re-running reuses existing users). Creates NO stations, so it never touches
 * or rotates the existing station API keys.
 */
import { db } from '../src/db/client.js';

const PASSWORD = 'PacyDemo123!';

const USERS = [
  { email: 'doctor2@pacy.test', role: 'doctor' as const, full_name: 'Dr. Sipho Ndlovu' },
  { email: 'pharmacy2@pacy.test', role: 'pharmacy' as const, full_name: 'Rosebank Care Pharmacy' },
];

async function findUserByEmail(email: string): Promise<string | null> {
  const { data, error } = await db().auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  return data.users.find((u) => u.email === email)?.id ?? null;
}

async function ensureUser(email: string): Promise<string> {
  const existing = await findUserByEmail(email);
  if (existing) {
    console.log(`  · ${email} already exists`);
    return existing;
  }
  const { data, error } = await db().auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  console.log(`  + created ${email}`);
  return data.user.id;
}

async function main() {
  console.log('\nSeeding extra test accounts (doctor2 + pharmacy2)...\n');
  const now = new Date().toISOString();

  for (const user of USERS) {
    const id = await ensureUser(user.email);

    const { error: pErr } = await db()
      .from('profiles')
      .upsert({ id, role: user.role, full_name: user.full_name }, { onConflict: 'id' });
    if (pErr) throw pErr;

    if (user.role === 'doctor') {
      const { error } = await db().from('doctors').upsert(
        { user_id: id, hpcsa_number: 'MP0654321', verification_status: 'verified', verified_at: now },
        { onConflict: 'user_id' },
      );
      if (error) throw error;
      console.log(`  ✓ ${user.email} verified (HPCSA MP0654321)`);
    } else {
      const { error } = await db().from('pharmacies').upsert(
        { user_id: id, sapc_number: 'P00654321', verification_status: 'verified', verified_at: now },
        { onConflict: 'user_id' },
      );
      if (error) throw error;
      console.log(`  ✓ ${user.email} verified (SAPC P00654321)`);
    }
  }

  console.log('\n─────────────────────────────────────────────');
  console.log('EXTRA TEST ACCOUNTS');
  console.log('─────────────────────────────────────────────');
  console.log('  doctor2@pacy.test');
  console.log('  pharmacy2@pacy.test');
  console.log(`  password  ${PASSWORD}`);
  console.log('  (verified; no stations created)');
  console.log('─────────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error('\nseed:extra failed:', err.message ?? err);
  process.exit(1);
});
