/**
 * Test-script equivalent of the doctor's browser-held signing key.
 *
 * In the real product this key is generated inside the doctor's browser as a
 * non-extractable WebCrypto key and never leaves the device. Scripts have no browser, so
 * they generate the same kind of key with `node:crypto` and enrol it the same way. The
 * wire format is identical — SPKI DER base64 for the public key, raw r‖s base64 for the
 * signature — so if a script can mint, so can the frontend.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { canonicalJson, normalizePrescriptionContent } from '../../src/lib/hash.js';

export type DoctorKey = {
  privateKey: KeyObject;
  publicKeyBase64: string;
};

export type SignedContent = {
  patient_id: string;
  doctor_id: string;
  drug_details: unknown;
  max_uses: number;
  expires_at: string | null;
};

export function generateDoctorKey(): DoctorKey {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { privateKey, publicKeyBase64: spki.toString('base64') };
}

/**
 * Signs prescription content exactly as the browser does: canonical JSON bytes, ECDSA
 * P-256 with SHA-256, raw r‖s encoding.
 *
 * `dsaEncoding: 'ieee-p1363'` is not optional — Node defaults to DER, which the backend
 * verifier rejects because WebCrypto never produces it.
 */
export function signContent(key: DoctorKey, content: SignedContent): string {
  const data = Buffer.from(canonicalJson(normalizePrescriptionContent(content)), 'utf8');
  return sign('sha256', data, { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString(
    'base64',
  );
}

/**
 * Builds a ready-to-POST `/prescriptions` body with a valid signature.
 *
 * Note `doctor_id` goes into the *signed content* but not into the request body — the
 * backend takes it from the JWT. Getting that wrong is the likeliest cause of a
 * mysterious INVALID_DOCTOR_SIGNATURE, so it lives here once rather than in each script.
 */
export function prescriptionBody(
  key: DoctorKey,
  content: SignedContent,
): Record<string, unknown> {
  return {
    patient_id: content.patient_id,
    drug_details: content.drug_details,
    max_uses: content.max_uses,
    expires_at: content.expires_at,
    doctor_signature: signContent(key, content),
  };
}

/** Generates a key and enrols it, returning the key plus its server-side fingerprint. */
export async function enrolDoctorKey(
  base: string,
  doctorToken: string,
): Promise<DoctorKey & { fingerprint: string }> {
  const key = generateDoctorKey();

  const res = await fetch(`${base}/doctor/signing-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${doctorToken}` },
    body: JSON.stringify({ public_key: key.publicKeyBase64 }),
  });

  const body = await res.json();
  if (res.status !== 201) {
    throw new Error(`Signing-key enrolment failed (${res.status}): ${JSON.stringify(body)}`);
  }

  return { ...key, fingerprint: body.fingerprint };
}
