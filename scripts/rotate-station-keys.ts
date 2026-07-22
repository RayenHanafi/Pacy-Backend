/**
 * Rotate the raw API keys for the existing doctor and pharmacy stations.
 *
 * The station rows and their owner assignments are preserved. Raw keys are emitted
 * once as JSON on stdout so an operator can pipe them directly into a device's
 * root-only configuration; the database continues to store SHA-256 hashes only.
 */
import { db } from '../src/db/client.js';
import { generateStationKey } from '../src/lib/hash.js';

type StationType = 'doctor' | 'pharmacy';

type StationRow = {
  id: string;
  type: StationType;
  label: string;
  api_key_hash: string;
};

async function restoreHashes(rows: StationRow[]): Promise<void> {
  for (const row of rows) {
    const { error } = await db()
      .from('stations')
      .update({ api_key_hash: row.api_key_hash })
      .eq('id', row.id);
    if (error) {
      console.error(`WARNING: failed to restore the ${row.type} station hash`);
    }
  }
}

async function main(): Promise<void> {
  const { data, error } = await db()
    .from('stations')
    .select('id, type, label, api_key_hash')
    .order('type');

  if (error) throw new Error(`Failed to load stations: ${error.message}`);
  const rows = (data ?? []) as StationRow[];
  const doctorRows = rows.filter((row) => row.type === 'doctor');
  const pharmacyRows = rows.filter((row) => row.type === 'pharmacy');
  if (rows.length !== 2 || doctorRows.length !== 1 || pharmacyRows.length !== 1) {
    throw new Error(
      `Expected exactly one doctor and one pharmacy station; found ${doctorRows.length} doctor and ${pharmacyRows.length} pharmacy`,
    );
  }

  const generated = {
    doctor: generateStationKey(),
    pharmacy: generateStationKey(),
  };
  const changed: StationRow[] = [];

  try {
    for (const row of rows) {
      const { error: updateError } = await db()
        .from('stations')
        .update({ api_key_hash: generated[row.type].hash })
        .eq('id', row.id);
      if (updateError) {
        throw new Error(`Failed to update the ${row.type} station: ${updateError.message}`);
      }
      changed.push(row);
    }

    const { data: verification, error: verificationError } = await db()
      .from('stations')
      .select('id, type, api_key_hash')
      .in(
        'id',
        rows.map((row) => row.id),
      );
    if (verificationError) {
      throw new Error(`Failed to verify station keys: ${verificationError.message}`);
    }

    for (const row of verification ?? []) {
      const type = row.type as StationType;
      if (row.api_key_hash !== generated[type].hash) {
        throw new Error(`Stored ${type} station hash did not match the generated key`);
      }
    }
    if ((verification ?? []).length !== 2) {
      throw new Error('Station key verification returned an incomplete result');
    }
  } catch (rotationError) {
    await restoreHashes(changed);
    throw rotationError;
  }

  process.stdout.write(
    JSON.stringify({
      stations: Object.fromEntries(
        rows.map((row) => [
          row.type,
          { id: row.id, label: row.label, key: generated[row.type].raw },
        ]),
      ),
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
