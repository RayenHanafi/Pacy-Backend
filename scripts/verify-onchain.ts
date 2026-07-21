/**
 * Independently audits a prescription against the Cardano ledger.
 *
 *   npm run verify -- <prescription-id>
 *   npm run verify                        # audits the most recent signed prescription
 *
 * This is the proof, not the claim. It re-derives everything from the stored record and
 * the public ledger, and checks three things:
 *
 *   1. The content hash on-chain matches a fresh hash of the database row.
 *      → the prescription has not been altered since it was written.
 *   2. The doctor's signature verifies against their enrolled public key.
 *      → a specific doctor authorised exactly this content. Pacy could not have forged
 *        it, because Pacy does not hold that private key.
 *   3. The signature stored off-chain matches the one recorded on-chain.
 *      → the database and the ledger tell the same story.
 *
 * Anyone holding the doctor's public key can run the equivalent of step 2 against public
 * chain data alone, without trusting this backend at all. That is the entire point.
 */
import { config, requireConfig } from '../src/config.js';
import { db } from '../src/db/client.js';
import { prescriptionContentHash } from '../src/lib/hash.js';
import { verifyDoctorSignature } from '../src/crypto/doctorSignature.js';

const BLOCKFROST = 'https://cardano-preprod.blockfrost.io/api/v0';

type Metadata = { hash?: string; sig?: string[]; v?: number };

async function chainMetadata(txHash: string): Promise<Metadata | null> {
  const res = await fetch(`${BLOCKFROST}/txs/${txHash}/metadata`, {
    headers: { project_id: requireConfig('BLOCKFROST_PROJECT_ID') },
  });
  if (!res.ok) throw new Error(`Blockfrost returned ${res.status} for tx ${txHash}`);
  const labels = (await res.json()) as { label: string; json_metadata: Metadata }[];
  return labels.find((l) => l.label === '674')?.json_metadata ?? null;
}

async function main() {
  const id = process.argv[2];

  const query = db()
    .from('prescriptions')
    .select(
      'id, patient_id, doctor_id, drug_details, content_hash, max_uses, expires_at, mint_tx_hash, doctor_signature, signing_key_id, created_at',
    );

  const { data, error } = id
    ? await query.eq('id', id).maybeSingle()
    : await query
        .not('doctor_signature', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

  if (error) throw new Error(`Database read failed: ${error.message}`);
  if (!data) throw new Error(id ? `No prescription ${id}` : 'No signed prescriptions found');

  const rx = data as any;
  console.log(`\nAuditing prescription ${rx.id}`);
  console.log(`  written ${rx.created_at}`);
  console.log(`  tx      https://preprod.cardanoscan.io/transaction/${rx.mint_tx_hash}\n`);

  if (!rx.doctor_signature || !rx.signing_key_id) {
    console.log('  ⚠  This prescription predates doctor signing — nothing to verify.');
    console.log('     Its content hash is still anchored on-chain, but no doctor');
    console.log('     signature exists, so authorship cannot be proven.\n');
    return;
  }

  const { data: keyRow, error: keyError } = await db()
    .from('doctor_signing_keys')
    .select('public_key, fingerprint, revoked_at')
    .eq('id', rx.signing_key_id)
    .single();
  if (keyError) throw new Error(`Failed to load signing key: ${keyError.message}`);

  const meta = await chainMetadata(rx.mint_tx_hash);
  if (!meta) throw new Error('No label-674 metadata found on the mint transaction');

  let ok = true;
  const check = (label: string, passed: boolean, detail = '') => {
    ok = ok && passed;
    console.log(`  ${passed ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  };

  // 1. Content integrity — rehash the row and compare to the ledger.
  const recomputed = prescriptionContentHash({
    patient_id: rx.patient_id,
    doctor_id: rx.doctor_id,
    drug_details: rx.drug_details,
    max_uses: rx.max_uses,
    expires_at: rx.expires_at,
  });
  check('content hash matches the database row', recomputed === rx.content_hash);
  check('content hash matches the ledger', meta.hash === rx.content_hash);

  // 2. Authorship — the signature verifies against the doctor's enrolled key.
  const signatureValid = verifyDoctorSignature({
    content: {
      patient_id: rx.patient_id,
      doctor_id: rx.doctor_id,
      drug_details: rx.drug_details,
      max_uses: rx.max_uses,
      expires_at: rx.expires_at,
    },
    signatureBase64: rx.doctor_signature,
    publicKeyBase64: keyRow.public_key,
  });
  check(`doctor signature verifies (key ${keyRow.fingerprint})`, signatureValid);

  // 3. The ledger and the database agree about the signature itself.
  const onChainSig = (meta.sig ?? []).join('');
  check('on-chain signature matches the stored one', onChainSig === rx.doctor_signature);

  if (keyRow.revoked_at) {
    console.log(
      `\n  Note: this signing key was revoked ${keyRow.revoked_at} (the doctor re-enrolled\n` +
        '  on another device). The signature remains valid — revocation stops future\n' +
        '  signing, it does not retract past authorisations.',
    );
  }

  console.log(
    ok
      ? '\n  VERIFIED — this prescription was authorised by the named doctor and has not\n' +
          '  been altered since. Pacy could not have produced it without their key.\n'
      : '\n  FAILED — do not trust this record.\n',
  );

  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('\nAudit failed:', err?.message ?? err);
  process.exit(1);
});
