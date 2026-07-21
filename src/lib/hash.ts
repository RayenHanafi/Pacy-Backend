import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Deterministic JSON encoding: object keys sorted recursively so the same logical
 * content always produces the same string — and therefore the same content hash.
 * Without this, key ordering would change the hash and break tamper-proofs.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortDeep(v)]));
  }
  return value;
}

export type PrescriptionContent = {
  patient_id: string;
  doctor_id: string;
  drug_details: unknown;
  max_uses: number;
  expires_at: string | null;
};

/**
 * Puts prescription content into the one form that both the signer and any later auditor
 * will produce.
 *
 * `expires_at` is the whole reason this exists. A client sends `2026-08-20T12:15:51.543Z`;
 * Postgres stores it as `timestamptz` and hands it back as `2026-08-20T12:15:51.543+00:00`.
 * Same instant, different string, different SHA-256 — so re-hashing the stored row
 * produced a hash that did not match the one on-chain, and the doctor's signature could
 * never be re-verified after a database round-trip. The audit was unreproducible by
 * construction, which would have quietly made the whole guarantee unprovable.
 *
 * Normalising through `Date` collapses every equivalent representation onto one.
 */
export function normalizePrescriptionContent(input: PrescriptionContent): PrescriptionContent {
  return {
    ...input,
    expires_at: input.expires_at === null ? null : new Date(input.expires_at).toISOString(),
  };
}

/**
 * The prescription content hash written to chain metadata.
 *
 * Covers exactly the fields that define the prescription's meaning, so the off-chain
 * record can later be proven un-tampered. Nothing here identifies a human on-chain —
 * only the resulting hash is published.
 */
export function prescriptionContentHash(input: PrescriptionContent): string {
  return sha256Hex(canonicalJson(normalizePrescriptionContent(input)));
}

/** Station API keys: random raw key shown once, only its hash is stored. */
export function generateStationKey(): { raw: string; hash: string } {
  const raw = `pacy_st_${randomBytes(24).toString('hex')}`;
  return { raw, hash: sha256Hex(raw) };
}

/** Constant-time comparison so key checks don't leak information by timing. */
export function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
