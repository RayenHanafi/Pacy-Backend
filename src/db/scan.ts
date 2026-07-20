import { db } from './client.js';
import { AppError, notFound } from '../lib/errors.js';

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

export type ScanContext = {
  patient: ScanPatient;
  station_type: 'doctor' | 'pharmacy';
  scanned_at: string;
  /** Only populated for pharmacy stations — a doctor doesn't need the dispense list. */
  prescriptions?: ScanPrescription[];
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

export async function buildScanContext(
  patientId: string,
  stationType: 'doctor' | 'pharmacy',
  scannedAt: string,
): Promise<ScanContext> {
  const patient = await loadPatient(patientId);
  const context: ScanContext = { patient, station_type: stationType, scanned_at: scannedAt };
  if (stationType === 'pharmacy') {
    context.prescriptions = await loadDispensable(patientId);
  }
  return context;
}

/** Records the latest scan for a station so the operator's browser can pick it up. */
export async function recordStationScan(stationId: string, patientId: string): Promise<string> {
  const scannedAt = new Date().toISOString();
  const { error } = await db()
    .from('station_scans')
    .upsert(
      { station_id: stationId, patient_id: patientId, scanned_at: scannedAt, consumed_at: null },
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

  return { patient_id: data.patient_id, scanned_at: data.scanned_at };
}
