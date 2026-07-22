import { db } from './client.js';
import { AppError, notFound } from '../lib/errors.js';
import { effectiveStatus, sortEvents, type TokenEvent } from './prescriptions.js';

export type ScanPatient = { id: string; full_name: string };

export type ScanPrescription = {
  id: string;
  drug_details: unknown;
  max_uses: number;
  uses_remaining: number;
  expires_at: string | null;
  status: string;
  policy_id: string | null;
  asset_name: string | null;
  mint_tx_hash: string | null;
  created_at: string;
};

/** A prescription the pharmacy can no longer dispense, with its full chain trail. */
export type CompletedPrescription = ScanPrescription & { events: TokenEvent[] };

export type ScanContext = {
  patient: ScanPatient;
  station_type: 'doctor' | 'pharmacy';
  scanned_at: string;
  /** Only populated for pharmacy stations — a doctor doesn't need the dispense list. */
  prescriptions?: ScanPrescription[];
  /** Pharmacy only. Recently spent/revoked/expired scripts — see `loadRecentlyCompleted`. */
  recently_completed?: CompletedPrescription[];
};

export async function loadPatient(patientId: string): Promise<ScanPatient> {
  const { data, error } = await db()
    .from('profiles')
    .select('id, full_name, role')
    .eq('id', patientId)
    .maybeSingle();

  if (error) throw new AppError('INTERNAL_ERROR', 'Failed to load patient');
  if (!data || data.role !== 'patient') throw notFound('Patient not found');
  return { id: data.id, full_name: data.full_name };
}

/**
 * Active, dispensable prescriptions for a patient.
 *
 * Expiry is evaluated here rather than by a cron job: anything past `expires_at` is
 * filtered out on read, so a stale `active` row can never be offered for dispensing.
 */
export async function loadDispensable(patientId: string): Promise<ScanPrescription[]> {
  const { data, error } = await db()
    .from('prescriptions')
    .select(
      'id, drug_details, max_uses, uses_remaining, expires_at, status, policy_id, asset_name, mint_tx_hash, created_at',
    )
    .eq('patient_id', patientId)
    .eq('status', 'active')
    .gt('uses_remaining', 0)
    .order('created_at', { ascending: false });

  if (error) throw new AppError('INTERNAL_ERROR', 'Failed to load prescriptions');

  const now = Date.now();
  return (data ?? []).filter(
    (p) => p.expires_at === null || new Date(p.expires_at).getTime() > now,
  ) as ScanPrescription[];
}

const RECENT_WINDOW_DAYS = 30;

/**
 * Recently completed prescriptions — exhausted, revoked, or expired — with their event
 * trail attached.
 *
 * A pharmacist genuinely needs this: "was this already filled, and when?" is a normal
 * counter question, and answering it with an empty screen is worse than answering it
 * with the dispensing record. `loadDispensable` deliberately hides these, which is
 * right for the dispense list and wrong as the pharmacist's whole view of the patient.
 *
 * Nothing here is dispensable. Every one of these ids is refused by
 * `assertDispensable`, and the ledger would refuse the burn underneath that.
 */
export async function loadRecentlyCompleted(patientId: string): Promise<CompletedPrescription[]> {
  const since = new Date(Date.now() - RECENT_WINDOW_DAYS * 86_400_000).toISOString();

  const { data, error } = await db()
    .from('prescriptions')
    .select(
      'id, drug_details, max_uses, uses_remaining, expires_at, status, policy_id, asset_name, mint_tx_hash, created_at, token_events (id, event_type, actor_role, tx_hash, created_at)',
    )
    .eq('patient_id', patientId)
    .gte('created_at', since)
    .order('created_at', { ascending: false });

  if (error) throw new AppError('INTERNAL_ERROR', 'Failed to load dispensing history');

  const now = Date.now();
  return (data ?? [])
    .filter((p: any) => {
      const expired = p.expires_at !== null && new Date(p.expires_at).getTime() <= now;
      // The exact complement of loadDispensable's filter, so a prescription can never
      // appear in both lists — or fall through the gap between them.
      const dispensable = p.status === 'active' && p.uses_remaining > 0 && !expired;
      return !dispensable;
    })
    .map((row: any) => {
      const { token_events, ...rest } = row;
      return {
        ...rest,
        status: effectiveStatus(rest),
        events: sortEvents(token_events),
      } as CompletedPrescription;
    });
}

export async function buildScanContext(
  patientId: string,
  stationType: 'doctor' | 'pharmacy',
  scannedAt: string,
): Promise<ScanContext> {
  const patient = await loadPatient(patientId);
  const context: ScanContext = { patient, station_type: stationType, scanned_at: scannedAt };
  if (stationType === 'pharmacy') {
    const [dispensable, completed] = await Promise.all([
      loadDispensable(patientId),
      loadRecentlyCompleted(patientId),
    ]);
    context.prescriptions = dispensable;
    context.recently_completed = completed;
  }
  return context;
}

/** Records the latest scan for a station so the operator's browser can pick it up. */
export async function recordStationScan(
  stationId: string,
  patientId: string,
  consumed = false,
): Promise<string> {
  const scannedAt = new Date().toISOString();
  const { error } = await db()
    .from('station_scans')
    .upsert(
      {
        station_id: stationId,
        patient_id: patientId,
        scanned_at: scannedAt,
        consumed_at: consumed ? scannedAt : null,
      },
      { onConflict: 'station_id' },
    );
  if (error) throw new AppError('INTERNAL_ERROR', 'Failed to record scan');
  return scannedAt;
}

/**
 * Most recent unconsumed scan for a station, if it is still fresh.
 *
 * Scans go stale after `maxAgeSeconds` so a browser opening the dashboard later doesn't
 * silently act on a patient who was scanned much earlier.
 */
export async function takeCurrentScan(
  stationId: string,
  maxAgeSeconds = 120,
): Promise<{ patient_id: string; scanned_at: string } | null> {
  const { data, error } = await db()
    .from('station_scans')
    .select('patient_id, scanned_at, consumed_at')
    .eq('station_id', stationId)
    .maybeSingle();

  if (error) throw new AppError('INTERNAL_ERROR', 'Failed to load station scan');
  if (!data || data.consumed_at !== null) return null;

  const age = (Date.now() - new Date(data.scanned_at).getTime()) / 1000;
  if (age > maxAgeSeconds) return null;

  // Claim exactly the scan we read. Including scanned_at and consumed_at in
  // the filter makes concurrent browser polls safe: only one request can take
  // this scan, and a newer Raspberry Pi scan can never be consumed by an older
  // in-flight request.
  const { data: consumed, error: consumeError } = await db()
    .from('station_scans')
    .update({ consumed_at: new Date().toISOString() })
    .eq('station_id', stationId)
    .eq('scanned_at', data.scanned_at)
    .is('consumed_at', null)
    .select('patient_id, scanned_at')
    .maybeSingle();

  if (consumeError) throw new AppError('INTERNAL_ERROR', 'Failed to consume station scan');
  if (!consumed) return null;

  return { patient_id: consumed.patient_id, scanned_at: consumed.scanned_at };
}
