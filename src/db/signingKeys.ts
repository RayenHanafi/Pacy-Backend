import { db } from './client.js';
import { AppError } from '../lib/errors.js';
import { keyFingerprint, parsePublicKey } from '../crypto/doctorSignature.js';

export type SigningKeyRow = {
  id: string;
  doctor_id: string;
  public_key: string;
  fingerprint: string;
  created_at: string;
  revoked_at: string | null;
};

const COLUMNS = 'id, doctor_id, public_key, fingerprint, created_at, revoked_at';

/** The doctor's currently active key, or null if they have never enrolled. */
export async function getActiveKey(doctorId: string): Promise<SigningKeyRow | null> {
  const { data, error } = await db()
    .from('doctor_signing_keys')
    .select(COLUMNS)
    .eq('doctor_id', doctorId)
    .is('revoked_at', null)
    .maybeSingle();

  if (error) throw new AppError('INTERNAL_ERROR', `Failed to load signing key: ${error.message}`);
  return (data as SigningKeyRow) ?? null;
}

/**
 * Enrols a new public key, revoking whatever was active before.
 *
 * Re-enrolment is the recovery path for a lost or replaced device — deliberately, because
 * the alternative is an exportable key, and an exportable key is a copyable one. Copyable
 * keys destroy the only property this whole mechanism buys.
 *
 * The old row is revoked, never deleted: prescriptions it signed must stay verifiable for
 * as long as they exist. A doctor changing phones does not cast doubt on their history.
 */
export async function enrolKey(
  doctorId: string,
  publicKeyBase64: string,
): Promise<{ key: SigningKeyRow; replacedPrevious: boolean }> {
  // Reject a malformed or wrong-curve key before touching the database, so a failed
  // enrolment never revokes a working key.
  parsePublicKey(publicKeyBase64);

  const previous = await getActiveKey(doctorId);

  if (previous) {
    if (previous.public_key === publicKeyBase64) {
      // Same device re-announcing itself — idempotent, and revoking then re-inserting
      // the identical key would churn the audit trail for no reason.
      return { key: previous, replacedPrevious: false };
    }

    const { error } = await db()
      .from('doctor_signing_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', previous.id);
    if (error) throw new AppError('INTERNAL_ERROR', 'Failed to revoke previous signing key');
  }

  const { data, error } = await db()
    .from('doctor_signing_keys')
    .insert({
      doctor_id: doctorId,
      public_key: publicKeyBase64,
      fingerprint: keyFingerprint(publicKeyBase64),
    })
    .select(COLUMNS)
    .single();

  if (error) throw new AppError('INTERNAL_ERROR', `Failed to enrol signing key: ${error.message}`);
  return { key: data as SigningKeyRow, replacedPrevious: previous !== null };
}
