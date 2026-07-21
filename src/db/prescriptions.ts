import { db } from './client.js';
import { AppError, notFound } from '../lib/errors.js';
import type { Role } from '../auth/context.js';

export type PrescriptionStatus = 'active' | 'fully_dispensed' | 'expired' | 'revoked';

export type PrescriptionRow = {
  id: string;
  patient_id: string;
  doctor_id: string;
  drug_details: unknown;
  content_hash: string;
  max_uses: number;
  uses_remaining: number;
  expires_at: string | null;
  policy_id: string | null;
  asset_name: string | null;
  mint_tx_hash: string | null;
  status: PrescriptionStatus;
  created_at: string;
  /** Null on prescriptions minted before doctor signing existed. */
  doctor_signature: string | null;
  signing_key_id: string | null;
};

const COLUMNS =
  'id, patient_id, doctor_id, drug_details, content_hash, max_uses, uses_remaining, expires_at, policy_id, asset_name, mint_tx_hash, status, created_at, doctor_signature, signing_key_id';

/**
 * Effective status for display. A prescription past its expiry is `expired` even if the
 * stored row still says `active` — expiry is evaluated on read rather than by a cron
 * job, so a stale row can never be presented as dispensable.
 */
export function effectiveStatus(row: {
  status: PrescriptionStatus;
  expires_at: string | null;
}): PrescriptionStatus {
  if (row.status === 'active' && row.expires_at !== null) {
    if (new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
  }
  return row.status;
}

export async function createPrescription(input: {
  patient_id: string;
  doctor_id: string;
  drug_details: unknown;
  content_hash: string;
  max_uses: number;
  expires_at: string | null;
  doctor_signature: string;
  signing_key_id: string;
}): Promise<PrescriptionRow> {
  const { data, error } = await db()
    .from('prescriptions')
    .insert({ ...input, uses_remaining: input.max_uses, status: 'active' })
    .select(COLUMNS)
    .single();

  if (error) throw new AppError('INTERNAL_ERROR', `Failed to create prescription: ${error.message}`);
  return data as PrescriptionRow;
}

export async function attachMint(
  prescriptionId: string,
  mint: { policy_id: string; asset_name: string; tx_hash: string },
): Promise<PrescriptionRow> {
  const { data, error } = await db()
    .from('prescriptions')
    .update({
      policy_id: mint.policy_id,
      asset_name: mint.asset_name,
      mint_tx_hash: mint.tx_hash,
    })
    .eq('id', prescriptionId)
    .select(COLUMNS)
    .single();

  if (error) throw new AppError('INTERNAL_ERROR', 'Failed to record mint details');
  return data as PrescriptionRow;
}

/** Used to roll back when the chain refuses a mint — never leave a token-less row active. */
export async function deletePrescription(prescriptionId: string): Promise<void> {
  await db().from('prescriptions').delete().eq('id', prescriptionId);
}

export async function getPrescription(id: string): Promise<PrescriptionRow> {
  const { data, error } = await db().from('prescriptions').select(COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new AppError('INTERNAL_ERROR', 'Failed to load prescription');
  if (!data) throw notFound('Prescription not found');
  return data as PrescriptionRow;
}

/**
 * Server-side re-validation before any burn. Never trust the client about status,
 * expiry, or remaining uses (CLAUDE.md golden rule 3). Each failure maps to a distinct
 * error code so the UI can name the reason rather than showing a generic error.
 */
export function assertDispensable(row: PrescriptionRow): void {
  if (row.status === 'revoked') {
    throw new AppError('PRESCRIPTION_REVOKED', 'This prescription has been revoked');
  }
  if (row.status === 'fully_dispensed' || row.uses_remaining <= 0) {
    throw new AppError('PRESCRIPTION_EXHAUSTED', 'This prescription has no fills remaining');
  }
  if (effectiveStatus(row) === 'expired') {
    throw new AppError('PRESCRIPTION_EXPIRED', 'This prescription has expired');
  }
  if (row.status !== 'active') {
    throw new AppError('PRESCRIPTION_NOT_ACTIVE', `Prescription is ${row.status}`);
  }
  if (!row.policy_id || !row.asset_name) {
    throw new AppError('PRESCRIPTION_NOT_ACTIVE', 'Prescription has no minted token');
  }
}

/**
 * Decrements one use, flipping to `fully_dispensed` at zero.
 *
 * Guarded on the previously-read `uses_remaining` so two concurrent dispenses cannot
 * both decrement from the same starting value; the loser gets a conflict instead of
 * silently double-spending a fill.
 */
export async function consumeUse(
  id: string,
  expectedRemaining: number,
): Promise<PrescriptionRow> {
  const next = expectedRemaining - 1;

  const { data, error } = await db()
    .from('prescriptions')
    .update({
      uses_remaining: next,
      status: next === 0 ? 'fully_dispensed' : 'active',
    })
    .eq('id', id)
    .eq('uses_remaining', expectedRemaining)
    .select(COLUMNS)
    .maybeSingle();

  if (error) throw new AppError('INTERNAL_ERROR', `Failed to record dispense: ${error.message}`);
  if (!data) {
    throw new AppError(
      'PRESCRIPTION_NOT_ACTIVE',
      'Prescription changed during dispense — please retry',
    );
  }
  return data as PrescriptionRow;
}

/** Marks all remaining fills consumed — used by revoke. */
export async function markRevoked(id: string): Promise<PrescriptionRow> {
  const { data, error } = await db()
    .from('prescriptions')
    .update({ uses_remaining: 0, status: 'revoked' })
    .eq('id', id)
    .select(COLUMNS)
    .single();

  if (error) throw new AppError('INTERNAL_ERROR', 'Failed to revoke prescription');
  return data as PrescriptionRow;
}

export type TokenEvent = {
  id: string;
  event_type: 'mint' | 'burn' | 'revoke';
  actor_role: Role | null;
  tx_hash: string | null;
  created_at: string;
};

export async function recordEvent(input: {
  prescription_id: string;
  event_type: 'mint' | 'burn' | 'revoke';
  actor_id: string | null;
  actor_role: Role | null;
  station_id?: string | null;
  tx_hash: string | null;
}): Promise<void> {
  const { error } = await db().from('token_events').insert({
    prescription_id: input.prescription_id,
    event_type: input.event_type,
    actor_id: input.actor_id,
    actor_role: input.actor_role,
    station_id: input.station_id ?? null,
    tx_hash: input.tx_hash,
  });
  if (error) throw new AppError('INTERNAL_ERROR', `Failed to record token event: ${error.message}`);
}

/**
 * Every prescription this doctor has written, newest first.
 *
 * Without this a doctor can only revoke the script they just minted, from the mint
 * confirmation screen — last week's prescription would be unreachable.
 *
 * Patient names are fetched in a second query rather than as a nested select: there are
 * two foreign keys from `prescriptions` into `profiles` (patient and doctor), so an
 * embedded join has to be disambiguated by constraint name, which is brittle.
 */
export async function listForDoctor(
  doctorId: string,
): Promise<(PrescriptionRow & { patient: { id: string; full_name: string }; events: TokenEvent[] })[]> {
  const { data, error } = await db()
    .from('prescriptions')
    .select(`${COLUMNS}, token_events (id, event_type, actor_role, tx_hash, created_at)`)
    .eq('doctor_id', doctorId)
    .order('created_at', { ascending: false });

  if (error) throw new AppError('INTERNAL_ERROR', `Failed to load prescriptions: ${error.message}`);

  const rows = data ?? [];
  const patientIds = [...new Set(rows.map((r: any) => r.patient_id))];

  const names = new Map<string, string>();
  if (patientIds.length > 0) {
    const { data: profiles, error: profileError } = await db()
      .from('profiles')
      .select('id, full_name')
      .in('id', patientIds);
    if (profileError) throw new AppError('INTERNAL_ERROR', 'Failed to load patient names');
    for (const p of profiles ?? []) names.set(p.id, p.full_name);
  }

  return rows.map((row: any) => {
    const { token_events, ...rest } = row;
    return {
      ...rest,
      status: effectiveStatus(rest),
      patient: { id: rest.patient_id, full_name: names.get(rest.patient_id) ?? 'Unknown patient' },
      events: sortEvents(token_events),
    };
  });
}

export function sortEvents(events: TokenEvent[] | null | undefined): TokenEvent[] {
  return (events ?? [])
    .slice()
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

export async function listForPatient(
  patientId: string,
): Promise<(PrescriptionRow & { events: TokenEvent[] })[]> {
  const { data, error } = await db()
    .from('prescriptions')
    .select(`${COLUMNS}, token_events (id, event_type, actor_role, tx_hash, created_at)`)
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });

  if (error) throw new AppError('INTERNAL_ERROR', `Failed to load prescriptions: ${error.message}`);

  return (data ?? []).map((row: any) => {
    const { token_events, ...rest } = row;
    return {
      ...rest,
      status: effectiveStatus(rest),
      events: sortEvents(token_events),
    };
  });
}
