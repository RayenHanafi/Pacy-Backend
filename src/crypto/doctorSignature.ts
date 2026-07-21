import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { canonicalJson, normalizePrescriptionContent } from '../lib/hash.js';
import { AppError } from '../lib/errors.js';

/**
 * Doctor prescription signatures.
 *
 * The point of this module is narrow and worth stating plainly: without it, this backend
 * could mint a prescription token attributed to a real, named, licensed doctor who never
 * wrote it — and the forged record would be indistinguishable from their genuine ones.
 * With it, we cannot, because we do not hold the doctor's private key. It is generated in
 * their browser and never leaves the device.
 *
 * What this does NOT prevent, stated openly rather than buried: we control the doctor
 * registry, so we could still invent a fictitious doctor and enrol a key we generated.
 * That fraud is detectable — the HPCSA number would not match the public register — but
 * it is not prevented. Closing it requires the regulator to attest the key, which is a
 * partnership, not a code change. See EXPLANATION.md §15.
 */

/** ECDSA P-256 signature, raw r‖s. Not DER — this is what WebCrypto emits. */
const SIGNATURE_BYTES = 64;

/**
 * Exactly the fields covered by a doctor's signature.
 *
 * Identical to the input of `prescriptionContentHash`, deliberately: the doctor signs
 * precisely the content whose hash goes on-chain, so the signature and the hash cannot
 * describe different prescriptions.
 */
export type SignedContent = {
  patient_id: string;
  doctor_id: string;
  drug_details: unknown;
  max_uses: number;
  expires_at: string | null;
};

/**
 * The exact bytes a doctor signs.
 *
 * Canonical JSON (recursively key-sorted) so that the browser and this server produce
 * byte-identical input from the same logical prescription. Key order would otherwise
 * vary between JS engines and every signature would fail to verify.
 *
 * Timestamps are normalised for the same reason a database round-trip must not change
 * the answer — see `normalizePrescriptionContent`.
 */
export function signingPayload(content: SignedContent): Buffer {
  return Buffer.from(canonicalJson(normalizePrescriptionContent(content)), 'utf8');
}

/** Short, human-comparable identifier for a key — shown in the UI so a doctor can tell two devices apart. */
export function keyFingerprint(publicKeyBase64: string): string {
  return createHash('sha256')
    .update(Buffer.from(publicKeyBase64, 'base64'))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Parses an enrolled public key, rejecting anything that is not ECDSA P-256.
 *
 * The curve check matters. Without it a doctor (or anyone who could reach the enrolment
 * endpoint) could register a key on a weak or attacker-chosen curve and we would happily
 * verify signatures against it. Accepting only the algorithm we specified means the
 * strength of the guarantee is ours to decide, not the caller's.
 */
export function parsePublicKey(publicKeyBase64: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    throw new AppError('VALIDATION_ERROR', 'public_key is not a valid SPKI DER key');
  }

  if (key.asymmetricKeyType !== 'ec') {
    throw new AppError('VALIDATION_ERROR', 'Signing key must be ECDSA P-256');
  }
  // Node names P-256 by its OpenSSL alias.
  if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new AppError(
      'VALIDATION_ERROR',
      `Signing key must use the P-256 curve (got ${key.asymmetricKeyDetails?.namedCurve ?? 'unknown'})`,
    );
  }

  return key;
}

/**
 * Verifies a doctor's signature over prescription content.
 *
 * Returns a boolean rather than throwing on a bad signature: "did this verify" is a
 * question the caller answers with its own error code and message. Malformed *input*
 * still throws, because that is a different failure with a different meaning.
 */
export function verifyDoctorSignature(params: {
  content: SignedContent;
  signatureBase64: string;
  publicKeyBase64: string;
}): boolean {
  const signature = Buffer.from(params.signatureBase64, 'base64');

  // A wrong length is never a valid signature, and checking first gives a clearer
  // failure than letting the verifier reject it for opaque reasons.
  if (signature.length !== SIGNATURE_BYTES) return false;

  const key = parsePublicKey(params.publicKeyBase64);

  return cryptoVerify(
    'sha256',
    signingPayload(params.content),
    // WebCrypto produces raw r‖s; Node defaults to DER and would reject it silently.
    { key, dsaEncoding: 'ieee-p1363' },
    signature,
  );
}
